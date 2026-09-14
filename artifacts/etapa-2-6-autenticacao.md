# Etapa 2.6 — primeiro administrador e autenticação

Data da validação: 13/09/2026.

## Resultado

- O mecanismo existente `admin:create` foi preservado e endurecido para permitir somente o bootstrap do primeiro administrador.
- Foi criado exatamente um usuário administrador, ativo e aprovado.
- O e-mail foi normalizado antes da persistência.
- A senha foi armazenada somente como hash bcrypt com custo 12.
- Uma segunda tentativa de bootstrap é bloqueada quando já existe qualquer usuário.
- Nenhuma senha, token, e-mail ou outro dado identificador foi registrado neste relatório.
- Nenhum seed foi executado e nenhum dado fictício foi criado.
- A tabela de registros SAC permanece vazia.

## Validações funcionais

- Login real concluído com sucesso pelo administrador no frontend.
- Senha incorreta para o usuário existente: HTTP 401, código `INVALID_CREDENTIALS` e mensagem genérica.
- Usuário inexistente: HTTP 401 com a mesma política de erro genérico.
- Logout concluído pela interface e confirmado após recarregar a página: a tela de login permaneceu ativa.
- O frontend remove `sac_token` tanto de `localStorage` quanto de `sessionStorage` no logout.
- Nenhuma senha é persistida pelo frontend.
- `/sac-records` sem autenticação: HTTP 401.
- O carregamento autenticado da visão geral foi concluído sem erro e exibiu zero casos.
- Console do navegador: nenhum erro ou aviso durante a validação.

## Infraestrutura

- `/health`: HTTP 200.
- API: ativa.
- PostgreSQL local: conectado.
- Schema: pronto.
- Resposta observada: `{"status":"ok","api":"up","database":"connected","schema":"ready"}`.
- Execução local sem dependência de Docker.

## Testes e qualidade

- Testes da API: 18 aprovados.
- Testes do frontend: 6 aprovados.
- Total: 24 testes aprovados.
- Lint completo: aprovado.
- Build completo: aprovado.
- Prisma Client: gerado com sucesso no build.

## Estruturas reutilizadas

- Fluxo visual de login e sessão em `apps/web/src/AuthGateway.tsx`.
- Rotas reais de autenticação em `apps/api/src/modules/auth/auth.routes.ts`.
- Script administrativo já exposto pelo comando `pnpm --filter @sac/api admin:create`.
- Prisma, PostgreSQL local, middleware JWT e proteção das rotas existentes.

## Estruturas criadas ou evoluídas

- `apps/api/src/modules/auth/admin-bootstrap.ts`: serviço transacional de bootstrap com validação, normalização, bcrypt e bloqueio de duplicidade.
- `apps/api/src/modules/auth/admin-bootstrap.test.ts`: cobertura do bootstrap, normalização, hash e tentativa duplicada.
- `apps/api/scripts/create-admin.ts`: passou a delegar ao serviço seguro e não imprime dados identificadores.
- `README.md`: instruções seguras com variáveis temporárias do PowerShell e limpeza garantida em `finally`.

As novas estruturas foram necessárias porque o script anterior aceitava entrada insuficientemente validada e poderia sobrescrever um usuário existente. O restante do fluxo foi reutilizado sem duplicação.

## Observação de segurança

O logout invalida a sessão mantida pelo navegador removendo o JWT do armazenamento do cliente. A API usa JWT stateless e ainda não possui lista de revogação no servidor; portanto, revogação imediata de um token já copiado fora do navegador exigiria uma etapa futura específica.
