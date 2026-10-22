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

## Diretrizes de Entrada, Extração de Documentos e Organização do Formulário

1. **Natureza Provisória do Formulário**: O formulário e a organização atual dos campos são provisórios, aguardando definição oficial do processo de negócio. Não faça novas mudanças no formulário apenas para padronizá-lo neste momento. Preserve a implementação atual, incluindo as proteções de privacidade e acesso.
2. **Ausência de Padrão Único de Entrada**: Não existe um padrão único de documento de entrada. Os PDFs já testados representam exemplos práticos, não um modelo obrigatório ou exaustivo para todos os formulários.
3. **Isolamento de Regras por Formato**: Mantenha as regras de extração específicas de cada formato estritamente isoladas em seus respectivos módulos/parsers.
4. **Tratamento de Inexistência e Ambiguidade**: Quando um campo não existir no documento ou houver ambiguidade, permita revisão manual pelo operador, sem inventar dados nem forçar correspondências ou preenchimentos arbitrários.
5. **Três Níveis de Informação e Preservação de Rastreabilidade**: Preserve rigorosamente a distinção entre:
   - **Conteúdo extraído do documento** (original, íntegro e rastreável);
   - **Sugestões automáticas do sistema** (com sinalização de nível de confiança e pendência de confirmação);
   - **Informações confirmadas pelo operador** (decisão humana soberana).
6. **Proteções de Privacidade e Governança de Acesso**:
   - Dados sensíveis e dados clínicos de pacientes permanecem protegidos por padrão (mascaramento como `***`, inclusive para nomes de arquivos citados contendo identificação pessoal, sem vazamento de fragmentos ou datas de nascimento).
   - A revelação de valores sensíveis é de acesso protegido exclusivo para o perfil de Administrador, com registro obrigatório de auditoria (`SENSITIVE_DATA_REVEALED`).
