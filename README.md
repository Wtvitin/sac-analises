# SAC Análises

Sistema interno para cadastrar, distribuir, investigar e analisar ocorrências relacionadas a pedidos.

## Arquitetura

- `apps/web`: React, TypeScript e Vite. A interface possui a Visão geral e a modal de acompanhamento do caso.
- `apps/api`: Express em camadas, validação com Zod e persistência PostgreSQL com Prisma.
- `apps/api/prisma`: modelo relacional, índices e migrações versionadas; o seed padrão não cria dados.

Datas são persistidas em UTC. A interface usa inicialmente `America/Sao_Paulo`.

## Requisitos

- Node.js 22+
- pnpm 10+
- PostgreSQL 18 instalado localmente no Windows e disponível em `localhost:5432`

> **Nota sobre infraestrutura:** O sistema foi projetado para execução nativa em Node.js e PostgreSQL diretamente no sistema operacional. Não há dependência de Docker para desenvolvimento, testes ou produção.

## Instalação

```bash
pnpm install
pnpm db:generate
pnpm --filter @sac/api exec prisma migrate status --schema prisma/schema.prisma
pnpm dev
```

No PowerShell, crie o arquivo local de ambiente com `Copy-Item .env.example .env` e configure `DATABASE_URL` com as credenciais do PostgreSQL local. Senhas com caracteres reservados devem ser codificadas para URL. Em produção, forneça outra `DATABASE_URL` pelo ambiente da hospedagem; não envie `.env` ao Git.

Antes da primeira execução, consulte `pnpm --filter @sac/api exec prisma migrate status --schema prisma/schema.prisma`. Revise qualquer migration pendente antes de aplicá-la. Nunca use `migrate reset` ou `db push` no banco principal.

## Primeiro administrador

O sistema não inclui credenciais ou usuários automáticos. Depois das migrações, execute no PowerShell aberto na raiz do projeto. Os valores são solicitados sem entrar no histórico, a senha fica oculta e as três variáveis são removidas ao final:

```powershell
$env:INITIAL_ADMIN_NAME = Read-Host 'Nome do administrador'
$env:INITIAL_ADMIN_EMAIL = Read-Host 'E-mail do administrador'
$securePassword = Read-Host 'Senha (mínimo de 12 caracteres)' -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $env:INITIAL_ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
  pnpm --filter @sac/api admin:create
} finally {
  Remove-Item Env:INITIAL_ADMIN_NAME,Env:INITIAL_ADMIN_EMAIL,Env:INITIAL_ADMIN_PASSWORD -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
  $securePassword.Dispose()
}
```

O comando cria somente o primeiro usuário e bloqueia execuções posteriores sem alterar a conta existente. A solicitação pública de acesso é controlada exclusivamente no backend por `REGISTRATION_ENABLED` e fica desabilitada por padrão, inclusive em produção. Quando habilitada, toda nova conta nasce inativa, não aprovada e com perfil Consulta; o solicitante nunca escolhe seu perfil. A resposta pública é genérica para não revelar se um e-mail já está cadastrado.

## Gestão de acesso

- Administradores aprovam solicitações como Analista ou Consulta, recusam sem excluir o registro e gerenciam perfil e estado.
- A API consulta o estado atual e a versão de segurança do usuário em toda requisição autenticada. Inativação, mudança de perfil e alteração de senha invalidam tokens anteriores imediatamente.
- O último administrador ativo e aprovado é protegido por lock transacional no PostgreSQL.
- Ao inativar alguém com casos abertos, o administrador deve transferi-los para um responsável elegível ou confirmar que ficarão sem responsável.
- Alterações administrativas e de senha são auditadas sem armazenar senhas, hashes, tokens ou credenciais.
- O último acesso é atualizado somente após login bem-sucedido e exibido em `America/Sao_Paulo`.

## Sessões e publicação segura

- Access tokens duram 15 minutos e refresh tokens duram 30 dias por padrão. Ambos são enviados somente em cookies `HttpOnly`; nenhum token fica disponível ao JavaScript ou aos armazenamentos do navegador.
- O refresh token é persistido apenas como hash HMAC, rotacionado transacionalmente e agrupado em uma família revogável. Reutilizar um token já rotacionado revoga toda a família.
- Toda mutação exige um token CSRF independente em cookie legível e no header `X-CSRF-Token`. CORS não substitui essa validação.
- Em produção (`NODE_ENV=production`) os cookies de autenticação recebem `Secure`. O desenvolvimento local continua aceitando HTTP com `SameSite=Lax`.
- `WEB_ORIGIN` deve ser uma origem explícita; curinga é rejeitado. `TRUST_PROXY` aceita somente `false`, `loopback` ou entre 1 e 3 proxies confiáveis.
- Alteração de senha, inativação, alteração de perfil, logout e revogações administrativas encerram as sessões correspondentes.

Frontend: `http://localhost:5173`  
API: `http://localhost:3333`  
Saúde da API: `http://localhost:3333/health`

## Validação e verificação de release

Para validação em desenvolvimento:

```bash
pnpm lint
pnpm test
pnpm build
```

Para verificação completa e unificada pré-release/deploy (auditoria de arquivos sensíveis, integridade de migrações, Prisma generate, tipagem, testes e build):

```bash
pnpm release:check
```

## Repositório remoto e controle de versão

### Diferença entre Git local e GitHub

- **Git local:** É o sistema de controle de versão distribuído que rastreia os commits, galhos (*branches*) e alterações diretamente no armazenamento local da sua máquina. Permite trabalho offline, inspeção de histórico e desenvolvimento seguro sem expor qualquer código publicamente.
- **GitHub:** É o serviço em nuvem que hospeda a cópia remota compartilhada do repositório. O envio do código (*push*) para o GitHub permite backup em nuvem, controle de acesso para colaboradores e acionamento de fluxos automatizados de integração contínua (CI).

### Procedimento seguro para configurar um repositório privado

1. Crie um repositório vazio no GitHub configurado obrigatoriamente como **Private**.
2. Não inicialize o repositório no GitHub com README, `.gitignore` ou licença (o projeto local já possui esses artefatos configurados e validados).
3. Utilize autenticação segura gerenciada localmente via SSH ou Git Credential Manager (GCM) com Personal Access Token (PAT) com escopo restrito (`repo`).
4. Vincule o repositório remoto:
   ```bash
   git remote add origin https://github.com/<usuario-ou-organizacao>/<nome-do-repositorio>.git
   ```
5. Envie a branch principal:
   ```bash
   git push -u origin main
   ```

> **Aviso de segurança:** Nunca compartilhe senhas, tokens de acesso pessoal (PAT), chaves SSH privadas ou credenciais de banco de dados em chats, mensagens ou arquivos versionados. Todas as credenciais de autenticação devem ser mantidas restritas ao ambiente seguro do operador.

### Política de arquivos de upload e dados pessoais

- Arquivos enviados por usuários (documentos, evidências, imagens de formulários, planilhas) e qualquer evidência contendo dados pessoais de clientes ou atendimentos **nunca** devem ser comitados no Git.
- Os diretórios locais de upload (`data/uploads/`, `apps/api/uploads/`) e arquivos temporários de importação estão estritamente bloqueados no `.gitignore`.
- Em ambiente de produção, utilize armazenamento persistente isolado ou bucket de object storage dedicado com controle de acesso rigoroso e criptografia em repouso.

## Variáveis de ambiente para produção

Em produção, as variáveis devem ser configuradas diretamente no painel seguro do ambiente de execução, sem versionar nenhum arquivo `.env`:

- `NODE_ENV`: Deve ser definido como `production` (habilita flag `Secure` em cookies e otimizações de runtime).
- `PORT`: Porta de escuta da API (ex.: `3333`).
- `DATABASE_URL`: String de conexão segura com o PostgreSQL em produção (com SSL/TLS obrigatório quando suportado).
- `JWT_SECRET`: Segredo criptográfico de alta entropia para assinatura dos tokens JWT (mínimo de 32 caracteres aleatórios).
- `WEB_ORIGIN`: Origem exata e autorizada do frontend (ex.: `https://sac.dominio.com.br`), sem barra no final. Curingas (`*`) são terminantemente proibidos.
- `TRUST_PROXY`: Configuração de proxy reverso (`false`, `loopback` ou quantidade/IPs dos proxies de terminação TLS).
- `REGISTRATION_ENABLED`: Mantido como `false` por padrão.
- `STORAGE_DRIVER`: `local` ou `s3`.
- Se `STORAGE_DRIVER=s3`:
  - `STORAGE_S3_ENDPOINT`: URL do endpoint do serviço de object storage.
  - `STORAGE_S3_REGION`: Região do bucket.
  - `STORAGE_S3_BUCKET`: Nome do bucket privado.
  - `STORAGE_S3_ACCESS_KEY_ID`: Chave de identificação de acesso.
  - `STORAGE_S3_SECRET_ACCESS_KEY`: Chave secreta de acesso.

## Checklists operacionais

### Checklist anterior ao primeiro push

- [ ] Confirmar que o working tree do Git está limpo e sem modificações não intencionais (`git status`).
- [ ] Confirmar que arquivos `.env` e arquivos locais de ambiente não estão rastreados nem no stage.
- [ ] Confirmar que nenhum diretório de uploads (`data/uploads/`, `apps/api/uploads/`) contém arquivos reais rastreados.
- [ ] Confirmar ausência de dumps de banco de dados, backups (`*.dump`, `*.sql.gz`, `*.bak`) e chaves privadas (`*.pem`, `*.key`).
- [ ] Executar com êxito a verificação unificada de release: `pnpm run release:check`.
- [ ] Confirmar que o repositório remoto criado no GitHub está explicitamente definido como **Private**.

### Checklist anterior ao deploy

- [ ] Executar com êxito a verificação unificada de release: `pnpm run release:check`.
- [ ] Confirmar que o banco de dados PostgreSQL de produção está acessível e com rotinas de backup ativas.
- [ ] Aplicar migrações versionadas pendentes com comando controlado: `pnpm --filter @sac/api prisma migrate deploy` (nunca use `migrate reset` ou `db push`).
- [ ] Configurar todas as variáveis de ambiente necessárias no painel da infraestrutura sem versioná-las.
- [ ] Inicializar o primeiro administrador utilizando o comando seguro `admin:create`.
- [ ] Validar a rota de saúde `/health` após a inicialização da API.

## Decisões do primeiro incremento

- Cliente é uma entidade reutilizável, conforme o modelo mínimo solicitado.
- Arquivos usam metadados no banco e uma chave de armazenamento, permitindo trocar disco local por object storage.
- Arquivamento é lógico por `archivedAt`.
- O acompanhamento usa status e histórico cronológico, sem barra ou percentual de progresso.
- A interface inicia sem registros, usuários fictícios, notificações ou indicadores simulados.
