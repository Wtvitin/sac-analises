# Etapa 5 — Segregação por setor no SAC Análises

## Resultado

A etapa implementa a segregação e isolamento por setor (departamento) em todo o fluxo do SAC Análises (backend e frontend), garantindo confidencialidade entre áreas de negócio sem perda de histórico, sem mutações destrutivas e sem inferência fictícia de dados legados.

## Regras de negócio implementadas

- **ADMIN:** visualização e gestão global de casos, anexos, métricas e relatórios de todos os setores. Pode classificar ou transferir o setor de um chamado com auditoria obrigatória.
- **ANALYST:** visualização e operação estritamente restritas aos casos pertencentes ao seu próprio setor cadastrado. Abertura de novos casos vincula o setor da identidade autenticada no servidor.
- **VIEWER (Consulta):** visualização estritamente restrita aos casos pertencentes ao seu próprio setor, permanecendo com acesso somente leitura.
- **Isolamento de acesso direto:** acessos diretos por ID (detalhes, histórico, comentários, tratativas e download de anexos) de casos pertencentes a outro setor retornam HTTP 404 para prevenir enumeração de chamados.
- **Independência cadastral do caso:** o setor pertence à ocorrência (`SacRecord.department`). Mudar o setor cadastrado de um usuário reflete imediatamente em suas permissões futuras, sem reclassificar chamados históricos.
- **Tratamento de casos legados sem setor:** registros históricos com setor nulo permanecem visíveis exclusivamente para `ADMIN`, que dispõe de filtro ("Sem setor definido") e ação auditada de transferência para classificar a ocorrência.
- **Restrição de atribuição:** atribuição bloqueada caso o analista selecionado não pertença ao setor do chamado (`ASSIGNEE_DEPARTMENT_MISMATCH`). A lista de responsáveis elegíveis é escopada ao setor.

## Estruturas reutilizadas e evoluídas

- **Prisma Schema:** adicionada coluna `department String?` e índice `@@index([department])` no modelo `SacRecord`.
- **Autenticação e Sessão (`auth.middleware.ts`, `session.service.ts`):** `Express.Request.auth` estendido com o campo `department`.
- **Serviço de SAC (`sac.service.ts`):** escopo de setor aplicado em consultas Prisma, queries de contagem, métricas de atenção operacional, validação de responsáveis e mutações.
- **Auditoria (`ActivityLog`, `AdminAudit`):** registro de evento `DEPARTMENT_TRANSFERRED` e auditoria de ações administrativas na transferência de setor.
- **Download de Anexos (`attachment.routes.ts`):** verificação de setor do caso associado ao anexo antes da transmissão do arquivo.
- **Notificações (`notification.service.ts`):** agregação e listagens de alertas escopadas ao setor do analista.
- **Métricas e Relatórios (`analytics.service.ts`):** métricas e exportação CSV filtradas por setor, com suporte a filtros globais e de casos não classificados para `ADMIN`.
- **Frontend (`@sac/web`):**
  - `record-listing.ts` / `use-record-list.ts`: filtro por setor para administradores e badge/rótulo de setor nos registros.
  - `SacRecordForm.tsx`: setor fixo e bloqueado para analistas; seletor obrigatório para administradores.
  - `CaseOperationsModal.tsx`: aba e ação "Transferir Setor" exclusiva para `ADMIN`, com justificativa obrigatória e desvinculação automática de responsável divergente.

## Estrutura nova justificada

- **Migration `20260929170000_case_department`:** adiciona a coluna `department` em `SacRecord` de forma não destrutiva (`nullable`), permitindo preservar os casos legados sem invenção de dados.
- **Suíte de testes de segregação (`sac-sector-segregation.test.ts`):** 25 testes automatizados cobrindo a matriz completa de permissões entre múltiplos setores, acesso global de ADMIN, proteção contra enumeração, tentativas de bypass e integridade de transferências.
- **Testes de rotas diretas (`sac.routes.test.ts`):** validação das rotas diretas de SAC e permissões de tratativa.

## Verificações técnicas

- **Banco de dados real:** 17 migrations aplicadas e esquema em dia (`Database schema is up to date!`).
- **Nenhum reset, seed ou db push:** dados históricos preservados integralmente.
- **TypeScript / Lint:** aprovado em `@sac/api` e `@sac/web` (`pnpm run lint`).
- **Build de produção:** aprovado em `@sac/web` (`vite build`).
- **Suíte de testes:** 371 testes aprovados no total (300 testes na API e 71 no frontend).
- **Sem vazamento de segredos:** `.env`, uploads e dados reais permanecem preservados e fora do controle de versão.
