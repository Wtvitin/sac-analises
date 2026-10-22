# Diretriz do Projeto: Formulário Provisório e Processamento de Documentos de Entrada

**Data de Registro:** 20 de Outubro de 2026  
**Status:** Ativa / Vigente  
**Escopo:** Módulo de Importação de Documentos (`apps/api/src/lib/document-extraction`, `apps/api/src/modules/document-imports`) e Formulário SAC (`apps/web/src/SacRecordForm.tsx`).

---

## 1. Natureza Provisória do Formulário e da Organização dos Campos

* O formulário e a organização atual dos campos na interface são **provisórios**, aguardando definição oficial e consolidação do fluxo de atendimento e processo de negócio.
* **Decisão de congelamento de layout:** Não devem ser realizadas novas modificações ou reestruturações no formulário com o simples intuito de "padronizá-lo" preventivamente neste momento.
* A implementação atual deve ser integralmente preservada, mantendo a estabilidade visual e funcional já atingida.

---

## 2. Ausência de Padrão Único para Documentos de Entrada

* Não existe e não deve ser presumido um formato único ou obrigatório de documento de entrada.
* Os documentos e PDFs já testados (ex.: formulários do Outlook/Microsoft Forms com 1, 2 ou mais itens) são **amostras e exemplos de cenários reais**, e não uma especificação mandatória ou modelo rígido aplicável a todas as entradas.

---

## 3. Isolamento Arquitetural das Regras de Extração

* As rotinas de extração e regras de normalização de cada formato devem permanecer **estritamente isoladas** em seus próprios parsers e submódulos (ex.: `outlook-forms.parser.ts`, `xlsx.parser.ts`, etc.).
* É vedado acoplar suposições de um formato específico ao fluxo geral da aplicação.
* Quando um novo formato de documento surgir no futuro, deve ser adicionado um parser dedicado ou uma extensão sem retroalimentar regras que comprometam formatos pré-existentes.

---

## 4. Tratamento de Inexistência de Campos e Ambiguidade

* Se um campo esperado não constar no documento, ou se o valor identificado for ambíguo (como formatos híbridos, múltiplos itens ou valores não canônicos):
  * **Não inventar dados** (ex.: não completar zeros à esquerda, não assumir datas de ocorrência a partir do cabeçalho de e-mail, não supor códigos de produtos).
  * **Não forçar correspondências** indevidas ou não fundamentadas no documento original.
  * O sistema deve sinalizar a pendência com confiança `REVIEW_REQUIRED` / `UNIDENTIFIED` e exibir aviso claro, deixando o campo livre para conferência e preenchimento manual pelo operador.

---

## 5. Três Níveis de Informação e Rastreabilidade

O sistema deve preservar com clareza cristalina a distinção entre três camadas:
1. **Conteúdo do documento original:** Os dados e textos brutos extraídos do arquivo, preservados sem alteração na sessão do banco de dados.
2. **Sugestões automáticas do sistema:** Campos pré-preenchidos ou motivos sugeridos com nível de confiança explícito, mantidos como sugestão sujeita a revisão.
3. **Informações confirmadas pelo operador:** Os valores efetivamente validados, ajustados e submetidos no momento da criação/atualização do chamado, representando a decisão humana soberana.

---

## 6. Preservação das Proteções de Privacidade e Governança de Acesso

* **Proteção de Dados Pessoais (LGPD):**
  * Nomes de arquivos citados no formulário que contenham identificação pessoal (dados de pacientes, datas de nascimento, CPFs) devem aparecer integralmente como `"***"` no payload entregue ao cliente, sem preservar fragmentos, datas ou extensões.
  * O nome original permanece protegido internamente na sessão de importação.
* **Governança e Auditoria:**
  * A revelação de qualquer dado sensível (incluindo nomes originais de arquivos citados) é recurso restrito a usuários com perfil de **Administrador**.
  * Toda revelação deve obrigatoriamente gerar registro rastreável na tabela de auditoria (`SENSITIVE_DATA_REVEALED`), preservando o sigilo sem armazenar o valor sensível no log.
