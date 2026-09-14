# SAC Análises — etapa 2.5: infraestrutura local

## Diagnóstico confirmado

- PostgreSQL 18.1 instalado diretamente no Windows e disponível em `localhost:5432`.
- Banco confirmado: `sac_analises`; schema configurado: `public`.
- Prisma Client conectou e executou uma consulta de leitura com sucesso.
- O schema `public` está vazio: 0 tabelas e 0 enums esperados pelo Prisma.
- Existem duas migrations locais, ambas pendentes: `20260912000100_init` e `20260912013000_auth_and_remove_progress`.
- A segunda migration contém `DROP COLUMN "stage"`. Nenhuma migration foi aplicada porque a solicitação proíbe operações `DROP` e exige comunicação prévia.

## Alterações seguras realizadas

- A API carrega o `.env` raiz ignorado pelo Git no desenvolvimento. Em hospedagem, continua aceitando `DATABASE_URL` fornecida pelo ambiente.
- A inicialização valida `DATABASE_URL`, `JWT_SECRET` e `PORT`, sem fallback de banco nem credenciais no código.
- `/health` verifica conexão e disponibilidade mínima do schema com timeout de 2 segundos.
- O endpoint diferencia `database: connected/unavailable` e `schema: ready/pending/unknown`; não expõe URL, credenciais ou tabelas.
- `.env.example` utiliza porta 5432 e valores ilustrativos.
- README orienta PostgreSQL local sem Docker, consulta prévia das migrations e configuração externa para produção.
- O Compose legado, sem uso no desenvolvimento local, foi removido na etapa 4.5.

## Validação

- Conexão real do Prisma: aprovada.
- Estado das migrations: duas pendentes; nenhuma aplicada.
- Compatibilidade estrutural: pendente, pois o banco está vazio.
- Health check real: HTTP 503 com API ativa, banco conectado e schema pendente.
- Login real: bloqueado; `public.User` não existe. A API respondeu com erro genérico sem segredos.
- `/sac-records`: bloqueado; `public.SacRecord` não existe. A consulta autenticada de diagnóstico respondeu com erro genérico sem segredos.
- Frontend e API iniciaram conjuntamente antes da validação.
- Lint: aprovado.
- Testes: 21 aprovados (15 API e 6 frontend), incluindo conexão indisponível, timeout e schema pendente sem acessar o banco real.
- Build: aprovado, incluindo geração do Prisma Client.

## Próxima decisão necessária

O banco precisa receber as migrations antes de login e registros funcionarem. `prisma migrate deploy` aplicaria as duas migrations e executaria o `DROP COLUMN` presente na segunda, portanto não deve ser usado sob a restrição atual. É necessário autorizar especificamente a aplicação após revisar esse impacto ou definir uma estratégia de inicialização compatível com a proibição de `DROP`.

Nenhum seed, reset, db push, DROP, TRUNCATE, exclusão ou alteração de dados foi executado.
