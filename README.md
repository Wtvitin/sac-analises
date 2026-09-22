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

## Validação

```bash
pnpm lint
pnpm test
pnpm build
```

## Decisões do primeiro incremento

- Cliente é uma entidade reutilizável, conforme o modelo mínimo solicitado.
- Arquivos usam metadados no banco e uma chave de armazenamento, permitindo trocar disco local por object storage.
- Arquivamento é lógico por `archivedAt`.
- O acompanhamento usa status e histórico cronológico, sem barra ou percentual de progresso.
- A interface inicia sem registros, usuários fictícios, notificações ou indicadores simulados.
