# Regras de desenvolvimento do SAC Análises

## Regra obrigatória de preservação e reutilização

Antes de criar ou alterar qualquer arquivo, componente, página, rota, serviço, entidade, estilo, teste, configuração ou funcionalidade:

1. Inspecione a implementação existente e identifique o que já atende total ou parcialmente à necessidade.
2. Reutilize e evolua estruturas existentes quando estiverem adequadas.
3. Não recrie, duplique ou substitua algo que já funcione sem uma justificativa técnica concreta.
4. Crie uma nova estrutura somente quando não existir equivalente reutilizável ou quando adaptar a existente causar prejuízo claro à arquitetura, segurança, manutenção ou experiência do usuário.
5. Preserve funcionalidades úteis, decisões arquiteturais, identidade visual e alterações anteriores do usuário.
6. Faça mudanças incrementais e mantenha o projeto executável durante o desenvolvimento.

Ao concluir uma alteração, informe o que foi reutilizado, o que foi criado e por que qualquer nova estrutura foi necessária.
