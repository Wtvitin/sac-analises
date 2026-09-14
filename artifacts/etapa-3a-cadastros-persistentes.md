# Etapa 3A — cadastros persistentes

Data da validação: 13/09/2026.

## Situação anterior

- `Reason` e `Subreason` já existiam no Prisma, porém sem descrição, ordem de exibição ou chave normalizada.
- Canal existia apenas como texto em `SacRecord`.
- A página Cadastros mantinha uma lista local apenas para Motivos.
- A API `/catalog` possuía somente listagem ativa e criação mínima.

## Modelagem

- `Reason` foi reutilizado e recebeu `normalizedName`, `description`, `displayOrder` e índice determinístico.
- `Subreason` foi reutilizado e recebeu os mesmos campos, com unicidade normalizada dentro do motivo principal.
- `Channel` foi criado como catálogo persistente independente.
- `SacRecord.channel` foi preservado sem alteração para não mudar o formulário ou o histórico do SAC nesta etapa.

## Migration

Migration aplicada: `20260913000100_catalog_persistence`.

SQL revisado e executado:

```sql
ALTER TABLE "Reason"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "displayOrder" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "normalizedName" TEXT NOT NULL;

ALTER TABLE "Subreason"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "displayOrder" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "normalizedName" TEXT NOT NULL;

CREATE TABLE "Channel" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "description" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "displayOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Reason_normalizedName_key" ON "Reason"("normalizedName");
CREATE INDEX "Reason_active_displayOrder_name_idx" ON "Reason"("active", "displayOrder", "name");
CREATE UNIQUE INDEX "Subreason_reasonId_normalizedName_key" ON "Subreason"("reasonId", "normalizedName");
CREATE INDEX "Subreason_reasonId_active_displayOrder_name_idx" ON "Subreason"("reasonId", "active", "displayOrder", "name");
CREATE UNIQUE INDEX "Channel_name_key" ON "Channel"("name");
CREATE UNIQUE INDEX "Channel_normalizedName_key" ON "Channel"("normalizedName");
CREATE INDEX "Channel_active_displayOrder_name_idx" ON "Channel"("active", "displayOrder", "name");
```

O SQL é integralmente aditivo. Não contém `DROP`, `TRUNCATE`, `DELETE`, remoção de coluna, tabela, índice ou enum. As migrations anteriores não foram alteradas.

## API

### Motivos

- `GET /catalog/reasons`
- `GET /catalog/reasons/:id`
- `POST /catalog/reasons`
- `PATCH /catalog/reasons/:id`
- `PATCH /catalog/reasons/:id/status`
- `DELETE /catalog/reasons/:id` retorna HTTP 405 e orienta inativação.

### Submotivos

- `GET /catalog/subreasons`
- `POST /catalog/subreasons`
- `PATCH /catalog/subreasons/:id`
- `PATCH /catalog/subreasons/:id/status`
- `DELETE /catalog/subreasons/:id` retorna HTTP 405.

### Canais

- `GET /catalog/channels`
- `POST /catalog/channels`
- `PATCH /catalog/channels/:id`
- `PATCH /catalog/channels/:id/status`
- `DELETE /catalog/channels/:id` retorna HTTP 405.

As listagens suportam busca, estado, paginação, ordenação determinística e filtro de submotivos por motivo.

## Segurança e integridade

- Todas as rotas exigem autenticação.
- Criação, edição, ativação e inativação exigem `ADMIN` na API.
- Perfis sem permissão recebem HTTP 403 nas operações administrativas.
- Perfis autenticados não administradores consultam somente opções ativas.
- Submotivos ativos de motivos inativos não são oferecidos para novas seleções.
- Inativação de motivo não exclui nem altera seus submotivos ou casos históricos.
- Reativação e novos vínculos de submotivo exigem motivo ativo.
- Normalização remove espaços externos, reduz espaços repetidos e compara nomes sem diferença de caixa.
- Índices únicos no PostgreSQL impedem duplicidade inclusive sob concorrência.
- Operações críticas de submotivo usam transação serializável.
- Exclusão definitiva não foi implementada.

## Interface

- A tela existente Cadastros foi preservada e conectada à API real.
- Categorias: Motivos, Submotivos e Canais.
- Busca, filtro por estado, filtro por motivo, quantidade, carregamento, erro, estado vazio e paginação.
- Tabela compacta em desktop e cards em telas móveis.
- Badges textuais Ativo e Inativo.
- Modal responsivo de criação e edição com validação próxima aos campos.
- Bloqueio de múltiplos envios, estado de carregamento, fechamento por `Esc` e retorno de foco.
- Confirmação própria para alterações não salvas e inativação, sem `alert()`.
- Atualização da listagem sem recarregar a aplicação e feedback de sucesso.

## Validações executadas

- Prisma schema: válido.
- Prisma Client: gerado.
- `prisma migrate status`: banco atualizado, três migrations aplicadas.
- Lint: aprovado em API e frontend.
- Testes: 38 aprovados, sendo 28 da API e 10 do frontend.
- Build: aprovado em API e frontend.
- Health check: HTTP 200.
- Rotas de catálogo sem autenticação: HTTP 401.
- Permissões ADMIN/ANALYST/VIEWER validadas em ambiente isolado, sem usuários permanentes de teste.
- Estados vazios dos três catálogos validados no navegador autenticado.
- Modal, validação obrigatória, `Esc`, retorno de foco e aviso de alterações não salvas validados no navegador.
- Responsividade validada em 320, 375, 430, 768, 1024, 1366 e 1440 px.
- Nenhuma rolagem horizontal ou ação essencial inacessível foi encontrada.
- Console do navegador sem erros ou avisos.

## Quantidades finais

- Motivos: 0.
- Submotivos: 0.
- Canais: 0.
- Registros SAC: 0.
- Usuários: 1 administrador existente, sem alteração.

## Persistência real e pendências

A estrutura foi persistida no PostgreSQL e as listagens reais retornaram estado vazio após a migration. Nenhum cadastro de validação foi criado, pois não houve autorização para conteúdo real. A validação de criar, reiniciar, editar e inativar um registro real permanece opcional para uma etapa assistida pelo usuário.

Não foram alterados autenticação, bootstrap administrativo, fluxo/status do SAC, dashboard, notificações, modal de detalhes, formulário principal, integrações ou Docker.
