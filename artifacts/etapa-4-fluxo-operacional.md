# Etapa 4 — Fluxo operacional dos casos SAC

## Resultado

A etapa implementa o ciclo operacional sobre as estruturas existentes de `SacRecord`, `Comment` e `ActivityLog`, sem seed, reset, `db push` ou recriação de ambiente.

## Estruturas reutilizadas e evoluídas

- Rotas, autenticação e autorização Express existentes.
- Entidade `SacRecord`, campos de conclusão já existentes e controle otimista por `updatedAt`.
- Entidades `Comment` e `ActivityLog` para comentários persistentes e auditoria.
- Modal de quatro separadores, componentes visuais, listagem e toasts existentes.
- Formulário de criação/edição da etapa 3B; na edição, responsável, prioridade e prazo passaram a ser alterados apenas por ações operacionais auditadas.

## Implementações concluídas

- Máquina de estados centralizada com transições válidas e restrição administrativa para reativação.
- Atribuir, remover responsável, assumir, assumir e iniciar, alterar prioridade, alterar prazo, iniciar, concluir, cancelar, reabrir e reativar.
- Justificativa obrigatória para cancelamento, reabertura, reativação, redução de prioridade e prorrogação do prazo.
- Conclusão condicionada a resumo da solução, causa identificada, área responsável e ação corretiva.
- Concorrência otimista em todas as mutações críticas, com resposta HTTP 409 e mensagem orientativa.
- Comentários internos persistentes, sanitizados, com autoria e data/hora.
- Linha do tempo real, paginada e ordenada, sem eventos fictícios.
- Ações condicionadas ao status e papel do usuário; perfil `VIEWER` permanece somente leitura.
- Atualização incremental da listagem e feedback por toast, sem recarregar toda a aplicação.
- Estados de carregamento, erro e vazio; navegação por teclado, Escape e contenção de foco no modal.

## Estrutura nova justificada

- `CaseOperationsModal.tsx`: separa a complexidade operacional do componente principal, substituindo o modal estático anterior em vez de duplicá-lo.
- `case-workflow.ts`: política de disponibilidade de ações compartilhável e testável no frontend.
- Migration `20260914000100_case_workflow`: adiciona apenas `cancellationReason` e índice cronológico de comentários, necessários para persistência e consulta eficientes.
- Testes isolados de operações: necessários para cobrir regras, permissões, auditoria, sanitização e conflitos sem criar dados reais.

## Verificações

- PostgreSQL: conectado.
- Health check: `status=ok`, `api=up`, `database=connected`, `schema=ready`.
- Login: sessão administrativa validada na interface.
- Migrations: 5 encontradas e todas aplicadas.
- TypeScript/lint: API e web aprovados.
- Testes: 53 testes da API e 17 testes web aprovados.
- Build: API e web aprovados.
- Responsividade: listagem e navegação verificadas em viewport móvel de 390 × 844 e desktop.
- Console: nenhum erro novo da aplicação após reload.
- Git: indisponível, pois o diretório não contém `.git`.
- Dados reais: nenhum registro ou catálogo foi criado/alterado durante a validação.
