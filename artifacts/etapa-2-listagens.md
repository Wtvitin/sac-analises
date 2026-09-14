# SAC Análises — etapa 2: listagens

## Implementação

Reutilizados: tokens e fundação visual, App shell, sidebar, topbar, PageHeader, cliente HTTP, autenticação, permissões, modal de detalhes e endpoint `/sac-records`. Não houve migração, seed nem gravação de dados de teste no banco.

Problemas corrigidos: filtragem limitada aos primeiros 100 itens; busca sem motivo; ordenação apenas local; paginação vazia incorreta; ausência de distinção entre base vazia e filtros sem resultados; tabela extensa no celular; menus sem ação e excesso de largura em desktop.

- Registros e Visão Geral compartilham tabela, cards mobile, badges, estados vazio/carregamento/erro, menu Visualizar e paginação.
- Busca global por ticket, pedido, cliente e motivo com debounce de 300 ms; requisições abortadas e respostas antigas ignoradas. Busca, filtros, ordenação e paginação são enviados ao servidor.
- Filtros combináveis de status, prioridade, responsável, motivo, abertura, prazo, atraso e sem responsável. Chips removíveis, limpeza, validação de período e fechamento por Escape ou clique externo.
- Mantida a ordenação padrão da API: atualização mais recente. Ordenações alternativas executadas antes da paginação, com desempate por ID.
- Página inicial 1, tamanho padrão 20, opções 10/20/50/100. Sem rodapé para zero itens; sem anterior/próxima para página única. Alterações dos controles retornam à primeira página.
- Modal existente abre pela linha, card, teclado ou menu; sua abertura e fechamento preservam filtros e página.
- Cadastros reaproveita busca, estado vazio e paginação local; ações de linha sem implementação foram retiradas dessa lista. Equipe reaproveita busca e estado vazio.
- Tabela completa no desktop, colunas prioritárias no tablet e cards no celular; sem coluna de progresso.

## Arquivos

Evoluídos: `apps/web/src/App.tsx`, `apps/web/src/main.tsx`, `apps/api/src/modules/sac/sac.schema.ts`, `apps/api/src/modules/sac/sac.service.ts`.

Criados nesta etapa: `apps/web/src/record-listing.ts`, `apps/web/src/record-listing.test.ts`, `apps/web/src/use-record-list.ts`, `apps/web/src/records.css`, `apps/api/src/modules/sac/sac-list.test.ts`, `apps/web/tests/listing-preview.html` e `apps/web/tests/listing-preview.tsx`.

Os arquivos novos separam controles e lógica de consulta das telas, evitam duplicação entre as duas listagens e permitem testes sem depender de dados reais. O preview só funciona no modo `listing-test`; não faz parte da entrada de produção e bloqueia escritas. O servidor temporário de teste foi encerrado.

## Validação em 12/09/2026

- `pnpm -r lint`: aprovado (checagem TypeScript configurada no projeto).
- `pnpm -r test`: 15 testes aprovados, sendo 6 frontend e 9 API.
- `pnpm -r build`: aprovado após pausar a API para liberar a DLL do Prisma no Windows.
- Testes isolados de API: consulta da sexta página com offset 100, ordenação estável, filtros combinados, busca por motivo, contagem consistente, limites e período inválido. Prisma simulado; não substituem uma integração real com PostgreSQL.
- Navegador com fixtures em memória: base vazia na Visão Geral e em Registros; busca sem resultado; filtros combinados e sem resultado; debounce em digitação rápida; resposta lenta substituída; ordenação; zero, uma e múltiplas páginas; menu Visualizar; abertura/fechamento do modal preservando a página 2; erro e botão tentar novamente; datas invertidas e Escape.
- Larguras medidas: 320, 375, 430, 768, 1024, 1366 e 1440 px. Nenhuma rolagem horizontal da página após correção. Tabela com contêiner próprio no tablet; cards no celular.
- Console do preview: nenhuma mensagem de erro ou aviso na inspeção final.

## Pendências e limites

1. A conexão configurada em `.env` usa PostgreSQL em `localhost:5433`, que não está disponível. Há outro PostgreSQL na porta 5432, mas ele não foi adotado automaticamente. Docker Desktop não foi localizado. Login e integração real com o banco continuam pendentes de restabelecer a conexão correta; autenticação não foi alterada.
2. Equipe ainda usa uma lista local vazia; Cadastros ainda mantém cadastros em estado local, conforme a implementação anterior. Integrações persistentes e criação/edição de usuários ficam fora desta etapa. Os controles antigos de criação não ganharam fluxos novos.
3. Dashboards não foram redesenhados; sua consulta legada de até 100 itens permanece como pendência de uma etapa própria.
4. O conteúdo do modal de detalhes foi preservado, inclusive textos de histórico existentes que ainda não estão integrados ao histórico real.

Para repetir o teste visual isolado: `pnpm --filter @sac/web exec vite --mode listing-test --port 5174 --host 127.0.0.1` e abrir `/tests/listing-preview.html`. O parâmetro `?count=0` seleciona base vazia. Não use esse preview como sistema real.
