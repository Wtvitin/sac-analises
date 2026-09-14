# Etapa 3B — criação e edição dos registros de SAC

Data da validação: 14/09/2026.

## Auditoria anterior às alterações

- PostgreSQL conectado ao banco `sac_analises`, schema `public`.
- Health check HTTP 200 com API ativa, banco conectado e schema pronto.
- Sessão autenticada validada visualmente com perfil Administrador.
- Quatro migrations versionadas aplicadas; schema atualizado.
- A cópia local não contém diretório ou arquivo `.git`; por isso não foi possível obter `git status` ou distinguir alterações pendentes por commit.
- O `.env` existente foi preservado sem recriação ou sobrescrita.
- Nenhum seed, reset, `db push` ou operação destrutiva foi executado.

## Implementação 3B encontrada e reutilizada

### Persistência

- Migration existente `20260913013000_sac_creation_editing`.
- Reutilização de `Customer`, `SacRecord`, `SacItem`, `Attachment`, `ActivityLog`, `Reason`, `Subreason`, `Channel`, `User` e `TicketCounter`.
- Cliente mínimo normalizado, idempotência, observação interna e vínculo persistente do canal já modelados.
- Código interno anual sequencial e imutável no formato `SAC-AAAA-NNNN`.

### API

- `POST /sac-records` para criação.
- `GET /sac-records/:id` para carregar a edição.
- `PATCH /sac-records/:id` para edição.
- `GET /sac-records/external-ticket-check` para alerta de possível duplicidade.
- `GET /sac-records/customer-options` para reutilização de clientes.
- Autorização para Administrador e Analista; perfil Consulta permanece somente leitura.
- Validação de motivo, submotivo, canal e responsável, inclusive preservação de referências históricas inativas durante edição.
- Validação de datas, campos obrigatórios, itens, duplicidade consciente e anexos.
- Concorrência otimista com `updatedAt` e HTTP 409 para edição obsoleta.
- Histórico de criação e atualização em `ActivityLog`.

### Interface

- O componente existente `SacRecordForm` atende criação e edição no mesmo fluxo.
- Formulário dividido em identificação, classificação, descrição, atribuição/prazo, itens, evidências e análise interna.
- Seleção de catálogos reais e responsáveis disponíveis.
- Cadastro mínimo/reutilização de cliente, alerta de ticket externo duplicado e confirmação explícita.
- Itens repetíveis com confirmação antes de descartar conteúdo.
- Evidências PDF/JPG/PNG, até 10 MB por arquivo.
- Validação próxima aos campos, foco no primeiro erro, bloqueio de envio repetido, confirmação de alterações não salvas, `Esc`, armadilha de foco e retorno ao acionador.
- Ações Novo registro e Editar já integradas às listagens desktop e móvel.

## Itens restantes concluídos

- Corrigido o carregamento de registros reais na Visão geral e em Registros; antes a consulta era disparada somente ao abrir Dashboards.
- Corrigido o replay idempotente encontrado dentro da transação para responder como replay e permitir a limpeza das evidências temporárias, sem informar criação duplicada.
- Aplicado o limite de cinco evidências ao total já salvo mais novos arquivos durante edições, no frontend e na API.
- Adicionados testes isolados de criação, replay idempotente, edição, concorrência otimista, limite cumulativo de anexos, validação do formulário, payload e alterações não salvas.
- Nenhuma migration, endpoint ou componente funcional foi duplicado.

## Validações finais

- Lint aprovado na API e no frontend.
- 47 testes aprovados: 33 na API e 14 no frontend.
- Build de produção aprovado na API e no frontend.
- Health check final HTTP 200.
- Página Registros validada no navegador autenticado: carregamento concluído e estado vazio real exibido.
- Formulário Novo registro validado no navegador sem criar conteúdo; ausência de Motivos e Canais é informada e direciona para Cadastros.
- Modal fechado sem salvar dados.

## Estado de dados após a validação

- Um administrador ativo e aprovado.
- Nenhum registro SAC criado por esta validação.
- Nenhum seed ou conteúdo fictício inserido.

## Estruturas criadas nesta retomada

- `apps/api/src/modules/sac/sac-write.test.ts`: cobertura específica da persistência 3B, inexistente anteriormente.
- `apps/web/src/sac-form.test.ts`: cobertura específica do formulário 3B, inexistente anteriormente.
- Este artefato de conclusão, pois não havia documento correspondente à etapa 3B.

As estruturas funcionais existentes foram evoluídas de forma incremental. Não foi necessária nova migration, rota, entidade ou componente de formulário.
