import { sanitizeDocumentImportPayload } from '../privacy/privacy.service.js';
import { describe, expect, it } from 'vitest';
import { parseOutlookFormsDocument, isOutlookFormsDocument } from './outlook-forms.parser.js';
import { interpretDocumentText } from './form-interpreter.js';
import { matchAndScoreFields } from './field-matcher.js';
import { extractDocumentData } from './document-extraction.provider.js';
import { parsePdfDocument } from './pdf-text.parser.js';

// Helper to create a valid 2-page textual PDF with standard PDF 1.4 syntax
function createSyntheticTwoPagePdf(page1Lines: string[], page2Lines: string[]): Buffer {
  const stream1 = [
    'BT',
    '/F1 12 Tf',
    '72 700 Td',
    ...page1Lines.map((line, idx) => (idx === 0 ? `(${line}) Tj` : `0 -20 Td (${line}) Tj`)),
    'ET',
  ].join('\n');

  const stream2 = [
    'BT',
    '/F1 12 Tf',
    '72 700 Td',
    ...page2Lines.map((line, idx) => (idx === 0 ? `(${line}) Tj` : `0 -20 Td (${line}) Tj`)),
    'ET',
  ].join('\n');

  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>
endobj
4 0 obj
<< /Length ${stream1.length} >>
stream
${stream1}
endstream
endobj
5 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R >>
endobj
6 0 obj
<< /Length ${stream2.length} >>
stream
${stream2}
endstream
endobj
xref
0 7
0000000000 65535 f
trailer
<< /Size 7 /Root 1 0 R >>
startxref
500
%%EOF`;

  return Buffer.from(pdf);
}

describe('Outlook / Microsoft Forms Parser (Etapa 11.2)', () => {
  const syntheticPage1Lines = [
    'De: Microsoft Forms <forms@microsoft.com>',
    'Enviado em: 20 de agosto de 2026 14:30',
    'Para: Servico De Atendimento Ao Consumidor SAC',
    'Assunto: Resposta ao formulario: SAC Reclamacao Tecnica',
    'Nome do Profissional',
    'Dr. Carlos Eduardo Silva',
    'CRO/UF',
    '12345/SP',
    'CPF / CNPJ',
    '123.456.789-00',
    'Codigo do cliente',
    'CLI-9988',
    'Telefone',
    '(11) 98765-4321',
    'E-mail',
    'carlos.silva@exemplo.com.br',
    'Endereco',
    'Av. Paulista, 1000 - Bela Vista - Sao Paulo / SP',
    'Codigo do produto',
    'PROD-5501',
    'Descricao do produto',
    'Implante Dentario Titanio 3.75x10mm',
    'Numero do lote',
    '099812',
    'Quantidade',
    '2',
  ];

  const syntheticPage2Lines = [
    'Qual foi o ocorrido?',
    'Falha de travamento',
    'Descricao da ocorrencia',
    'Durante o procedimento cirurgico o componente apresentou desgaste anomalo na rosca.',
    'Segue em anexo a imagem radiografia_exame.png para comprovacao.',
    'Numero da nota fiscal',
    'NF-0012345',
    'Observacoes adicionais',
    'Paciente reagendado para a proxima semana',
  ];

  it('detects Outlook / Microsoft Forms structural anchors', () => {
    const sampleText = syntheticPage1Lines.join('\n') + '\n' + syntheticPage2Lines.join('\n');
    expect(isOutlookFormsDocument(sampleText)).toBe(true);
  });

  it('does NOT misclassify generic documents as Outlook / MS Forms', () => {
    const genericText = `
      Relatório de Vendas
      Data: 2026-09-01
      Total: R$ 500,00
      Status: Aprovado
    `;
    expect(isOutlookFormsDocument(genericText)).toBe(false);
  });

  it('parses 2-page textual PDF and extracts all expected fields end-to-end', async () => {
    const pdfBuffer = createSyntheticTwoPagePdf(syntheticPage1Lines, syntheticPage2Lines);

    // 1. Verify textual PDF physical extraction
    const rawPdf = await parsePdfDocument(pdfBuffer);
    expect(rawPdf.numPages).toBe(2);
    expect(rawPdf.isScanned).toBe(false);
    expect(rawPdf.text.length).toBeGreaterThan(100);

    // 2. Verify end-to-end extraction through provider
    const extraction = await extractDocumentData(pdfBuffer, 'formulario_msforms.pdf');
    expect(extraction.format).toBe('PDF');
    expect(extraction.modelId).toBe('OUTLOOK_MS_FORMS');
    expect(extraction.modelName).toBe('Formulário Outlook / Microsoft Forms');

    // Customer name: extracted with professional prefix stripped and HIGH confidence
    expect(extraction.customerName.value).toBe('Carlos Eduardo Silva');
    expect(extraction.customerName.confidenceLevel).toBe('HIGH');

    // Items: 1 item with code, description, batch and quantity
    expect(extraction.items).toBeDefined();
    expect(extraction.items.length).toBe(1);
    expect(extraction.items[0].code).toBe('PROD-5501');
    expect(extraction.items[0].description).toBe('Implante Dentario Titanio 3.75x10mm');
    expect(extraction.items[0].batch).toBe('099812');
    expect(extraction.items[0].requiresReview).toBe(false);
    expect(extraction.items[0].quantity).toBe(2);

    // Description of occurrence
    expect(extraction.description.value).toContain('Durante o procedimento cirurgico');
    expect(extraction.description.confidenceLevel).toBe('HIGH');

    // Invoice number: detected as metadata, NOT order number or ticket
    expect(extraction.invoiceNumber).toBeDefined();
    expect(extraction.invoiceNumber!.value).toBe('NF-0012345');
    expect(extraction.invoiceNumber!.confidenceLevel).toBe('HIGH');

    // Order number and external ticket MUST remain empty when not in document
    expect(extraction.orderNumber.value).toBe('');
    expect(extraction.externalTicket.value).toBe('');

    // Crucial: email header "Para: Servico De Atendimento Ao Consumidor SAC" must NOT produce ticket "Ao"
    expect(extraction.externalTicket.value).not.toBe('Ao');

    // Referenced files mentioned in text (not treated as attached files)
    expect(extraction.referencedFiles).toBeDefined();
    expect(extraction.referencedFiles!.length).toBe(1);
    expect(extraction.referencedFiles![0].name).toBe('radiografia_exame.png');
    expect(extraction.referencedFiles![0].attached).toBe(false);

    // Additional info: CRO, CPF/CNPJ, phone, email, address, etc.
    expect(extraction.additionalInfo).toBeDefined();
    expect(extraction.additionalInfo!.length).toBeGreaterThanOrEqual(5);

    const labels = extraction.additionalInfo!.map(i => i.label);
    expect(labels).toContain('CRO/UF');
    expect(labels).toContain('CPF / CNPJ');
    expect(labels).toContain('Código do Cliente');
    expect(labels).toContain('Telefone');
    expect(labels).toContain('E-mail');
    expect(labels).toContain('Endereço');
    expect(labels).toContain('Qual foi o ocorrido?');

    // Sensitive fields categorized appropriately
    const sensitive = extraction.additionalInfo!.find(i => i.label === 'CPF / CNPJ');
    expect(sensitive?.category).toBe('SENSITIVE');
  });

  it('matches suggestedReason against catalog when available', async () => {
    const rawText = syntheticPage1Lines.join('\n') + '\n' + syntheticPage2Lines.join('\n');
    const interpreted = interpretDocumentText(rawText);

    const mockCatalog = {
      reasons: [
        { id: 'reason-1', name: 'Falha de travamento' },
        { id: 'reason-2', name: 'Embalagem violada' },
      ],
      channels: [
        { id: 'chan-1', name: 'Microsoft Forms' },
      ],
    };

    const matched = await matchAndScoreFields(interpreted, 'PDF', false, mockCatalog);

    expect(matched.suggestedReason).toBeDefined();
    expect(matched.suggestedReason?.value).toBe('reason-1');
    expect(matched.suggestedReason?.confidenceLevel).toBe('HIGH');
  });

  it('does NOT invent reason or channel if not in catalog', async () => {
    const rawText = syntheticPage1Lines.join('\n') + '\n' + syntheticPage2Lines.join('\n');
    const interpreted = interpretDocumentText(rawText);

    const emptyCatalog = {
      reasons: [
        { id: 'reason-99', name: 'Outro motivo qualquer' },
      ],
      channels: [],
    };

    const matched = await matchAndScoreFields(interpreted, 'PDF', false, emptyCatalog);

    // Reason should not be forced if catalog does not match
    expect(matched.suggestedReason?.value || '').not.toBe('reason-99');
    // Channel should remain empty
    expect(matched.channelId?.value || '').toBe('');
  });

  it('handles partial / unknown forms gracefully with fallback parser', () => {
    const partialText = `
      Formulário de Contato
      Nome: Maria Santos
      Telefone: (21) 99999-8888
      Mensagem: Gostaria de saber mais sobre o produto.
    `;

    const interpreted = interpretDocumentText(partialText);
    // Should fallback to generic key-value parser
    expect(interpreted.modelId).toBe('KEY_VALUE_FORM');
    expect(interpreted.customerName.value).toBe('Maria Santos');
    // Order number and ticket remain empty
    expect(interpreted.orderNumber.value).toBe('');
    expect(interpreted.externalTicket.value).toBe('');
  });

  it('handles completely empty or unmatched fields without any exceptions or undefined properties', async () => {
    const emptyDocumentText = '';
    const interpreted = interpretDocumentText(emptyDocumentText);

    const emptyCatalog = {
      reasons: [],
      channels: [],
    };

    const matched = await matchAndScoreFields(interpreted, 'PDF', false, emptyCatalog);

    expect(matched).toBeDefined();
    expect(matched.customerName).toBeDefined();
    expect(matched.customerName.value).toBe('');
    expect(matched.customerName.confidence).toBe('UNIDENTIFIED');
    expect(matched.customerName.confidenceLevel).toBe('LOW');

    expect(matched.orderNumber).toBeDefined();
    expect(matched.orderNumber.value).toBe('');

    expect(matched.externalTicket).toBeDefined();
    expect(matched.externalTicket.value).toBe('');

    expect(matched.description).toBeDefined();
    expect(matched.description.value).toBe('');

    expect(matched.openedAt).toBeDefined();

    expect(matched.items).toEqual([]);
    expect(matched.additionalInfo).toEqual([]);
    expect(matched.referencedFiles).toEqual([]);

    expect(matched.summary.totalIdentified).toBeGreaterThanOrEqual(0);
    expect(matched.summary.totalReviewRequired).toBeGreaterThanOrEqual(0);
    expect(matched.summary.totalUnidentified).toBeGreaterThanOrEqual(0);
  });

  it('parses realistic 3-page Outlook/Forms fixture with clinical subquestions, customer code ?, and email timestamp', async () => {
    const synthetic3PageText = `
Outlook
Dra. Mariana Costa - Formulário preenchido - Reclamação de cliente Implantes
De Contato Implacil Osstem <contato@implacilosstem.com.br>
Data Sex, 21/08/2026 17:20
Para Serviço De Atendimento Ao Consumidor SAC <sac@implacilosstem.com.br>
Nome do Profissional
Dra. Mariana Costa
CRO/UF
MG12345
CPF / CNPJ
111.222.333-44
Código do cliente
?
Telefone
(31) 98888-7777
E-mail
mariana.costa@exemplo.com.br
Endereço
Rua das Flores 123 Bela Vista Curvelo / MG
Map It
Código do produto
1implante 222278 2 implantes 22276
Descrição do produto
1 implante CM 3.5x11 e 2 implantes 3,5x9
Número do lote
22,278
Quantidade
3
O item pode ter sido adquirido em seu nome ou em nome de outra pessoa física ou jurídica? Qual?
Física
*Deseja receber a reposição do mesmo item?
21/08/2026, 17:34 	ABRIR / ALTERAR TICKET - Serviço De Atendimento Ao Consumidor SAC - Outlook
https://outlook.cloud.microsoft/mail/12345 1/3
-- 1 of 3 --
Sim
Qual o produto que deseja reposição?
O mesmo
Descrição da ocorrência
Cirurgia de implante sem osseointegração com perda após 3 meses. Segue foto foto_exame_rx.jpg.
Qual foi o ocorrido?
Não osseointegração
Qual região o produto foi instalado?
11
12
24
Data da instalação (dd/mm/aaaa)
27/01/2026
Data da remoção (dd/mm/aaaa)
28/07/2026
Componente (dd/mm/aaaa)
Não
Qual foi a estabilidade primária alcançada (Torque Ncm)?
45
Realizada carga imediata?
Não
Osso do tipo:
III
Higiene oral:
Regular
Qual tipo de prótese seria realizado?
Unitária
Idade
56
Sexo
Masculino
21/08/2026, 17:34 	ABRIR / ALTERAR TICKET - Serviço De Atendimento Ao Consumidor SAC - Outlook
https://outlook.cloud.microsoft/mail/12345 2/3
-- 2 of 3 --
Dados clínicos do paciente
Alergia/Hipersensibilidade
Alguma cirurgia recente?
Não
Faz uso contínuo de algum medicamento? Se sim, quais?
Nenhum
Outras doenças? Se sim, quais?
Nenhuma
A perda do implante foi acompanhada por algum acontecimento
Outros
Alguma intercorrência durante a cirurgia?
Nenhuma
Digite aqui o número da Nota Fiscal
000786997
Declaração de Veracidade e Esterilização
Declaro serem verdadeiras todas as informações prestadas acima e que todos os itens descritos foram devidamente esterilizados.
21/08/2026, 17:34 	ABRIR / ALTERAR TICKET - Serviço De Atendimento Ao Consumidor SAC - Outlook
https://outlook.cloud.microsoft/mail/12345 3/3
-- 3 of 3 --
`;

    const interpreted = interpretDocumentText(synthetic3PageText);

    // 1. Model detection
    expect(interpreted.modelId).toBe('OUTLOOK_MS_FORMS');
    expect(interpreted.modelName).toBe('Formulário Outlook / Microsoft Forms');

    // 2. Customer Name (prefix stripped)
    expect(interpreted.customerName.value).toBe('Mariana Costa');
    expect(interpreted.customerName.confidenceLevel).toBe('HIGH');

    // 3. Email Date MUST require review and NOT be assumed as definitive occurrence date
    expect(interpreted.openedAt.value).toBe('2026-08-21T17:20');
    expect(interpreted.openedAt.requiresReview).toBe(true);
    expect(interpreted.openedAt.confidence).toBe('REVIEW_REQUIRED');
    expect(interpreted.openedAt.confidenceLevel).toBe('MEDIUM');
    expect(interpreted.openedAt.warning).toContain('cabeçalho do e-mail');

    // 4. References & Codes: Invoice identified; ? customer code strictly excluded
    expect(interpreted.invoiceNumber?.value).toBe('000786997');
    expect(interpreted.orderNumber.value).toBe('');
    expect(interpreted.externalTicket.value).toBe('');

    const candidateRefs = interpreted.candidateReferences || [];
    expect(candidateRefs.some(r => r.type === 'INVOICE' && r.value === '000786997')).toBe(true);
    expect(candidateRefs.some(r => r.type === 'CUSTOMER_CODE')).toBe(false);
    expect(candidateRefs.some(r => r.value === '?')).toBe(false);

    // 5. Occurrence reason must NOT bleed into trailing questions
    expect(interpreted.occurrenceReasonText).toBe('Não osseointegração');

    // 6. Clinical fields separated cleanly without noise
    const additional = interpreted.additionalInfo || [];
    const reasonItem = additional.find(i => i.label === 'Qual foi o ocorrido?');
    expect(reasonItem?.value).toBe('Não osseointegração');

    const installDate = additional.find(i => i.label === 'Data da instalação');
    expect(installDate?.value).toBe('27/01/2026');

    const removalDate = additional.find(i => i.label === 'Data da remoção');
    expect(removalDate?.value).toBe('28/07/2026');

    const torque = additional.find(i => i.label === 'Estabilidade primária (Torque Ncm)');
    expect(torque?.value).toBe('45');

    const prosthesis = additional.find(i => i.label === 'Tipo de Prótese');
    expect(prosthesis?.value).toBe('Unitária');

    // 7. Internal note is structured and concise, NOT a raw question blob
    expect(interpreted.internalNote?.value).toContain('NF: 000786997');
    expect(interpreted.internalNote?.value).toContain('Instalação: 27/01/2026');
    expect(interpreted.internalNote?.value).toContain('Remoção: 28/07/2026');
    expect(interpreted.internalNote?.value).toContain('Motivo relatado: Não osseointegração');
    expect(interpreted.internalNote?.value).not.toContain('Qual região o produto foi instalado?');

    // 8. Referenced files detected as unattached cited evidence
    expect(interpreted.referencedFiles).toBeDefined();
    expect(interpreted.referencedFiles?.length).toBe(1);
    expect(interpreted.referencedFiles![0].name).toBe('foto_exame_rx.jpg');
    expect(interpreted.referencedFiles![0].attached).toBe(false);

    // 9. Sensitive data and Patient Clinical Data marked correctly
    const cpf = additional.find(i => i.label === 'CPF / CNPJ');
    expect(cpf?.category).toBe('SENSITIVE');
    expect(cpf?.isSensitive).toBe(true);

    const cro = additional.find(i => i.label === 'CRO/UF');
    expect(cro?.category).toBe('SENSITIVE');
    expect(cro?.isSensitive).toBe(true);

    // Patient clinical data MUST have isSensitive: true
    const age = additional.find(i => i.label === 'Idade do paciente');
    expect(age?.isSensitive).toBe(true);
    const gender = additional.find(i => i.label === 'Sexo do paciente');
    expect(gender?.isSensitive).toBe(true);
    const medication = additional.find(i => i.label === 'Medicamento contínuo');
    expect(medication?.isSensitive).toBe(true);
    const diseases = additional.find(i => i.label === 'Outras doenças');
    expect(diseases?.isSensitive).toBe(true);

    // 10. CRITICAL: Contact, phone, email, patient health data must NEVER be copied into internalNote
    expect(interpreted.internalNote?.value).not.toContain('11999998888');
    expect(interpreted.internalNote?.value).not.toContain('mariana@clinica.com.br');
    expect(interpreted.internalNote?.value).not.toContain('Contato:');
    expect(interpreted.internalNote?.value).not.toContain('Idade:');
    expect(interpreted.internalNote?.value).not.toContain('54');

    // 11. CRITICAL: Source snippets must NOT leak raw contact information
    expect(interpreted.customerContact?.sourceSnippet).not.toContain('11999998888');
    expect(interpreted.customerContact?.sourceSnippet).not.toContain('mariana@clinica.com.br');

    // 12. Sanitized import payload conceals patient clinical data and contact completely
    const sanitized = sanitizeDocumentImportPayload(interpreted);
    expect(sanitized.customerContact.value).toBe('***');
    expect(sanitized.customerContact.sourceSnippet).not.toContain('11999998888');

    const sanitizedAge = sanitized.additionalInfo.find((i: any) => i.label === 'Idade do paciente');
    expect(sanitizedAge?.value).toBe('***');
    expect(sanitizedAge?.isMasked).toBe(true);
    expect(sanitizedAge?.sensitiveCategory).toBe('CLINICAL');

    const sanitizedMed = sanitized.additionalInfo.find((i: any) => i.label === 'Medicamento contínuo');
    expect(sanitizedMed?.value).toBe('***');
    expect(sanitizedMed?.isMasked).toBe(true);

    const serializedSanitized = JSON.stringify(sanitized);
    expect(serializedSanitized).not.toContain('11999998888');
    expect(serializedSanitized).not.toContain('mariana@clinica.com.br');
  });

  
  describe('Regras de Lote na Importação de Documentos Outlook/Forms', () => {
    const makeRawDoc = (lines: string[]): any => ({
      text: lines.join('\n'),
      format: 'PDF',
      warnings: [],
    });

    it('extrai lote válido de 6 dígitos preservando como string', () => {
      const doc = makeRawDoc([
        'Nome do Profissional', 'Dr. Teste',
        'Codigo do produto', 'PR-01',
        'Descricao do produto', 'Item Teste',
        'Numero do lote', '146157',
        'Quantidade', '1',
        'Descricao da ocorrencia', 'Ocorrencia teste para lote valido de 6 digitos.',
      ]);
      const extraction = parseOutlookFormsDocument(doc);
      expect(extraction.items[0].batch).toBe('146157');
      expect(extraction.items[0].requiresReview).toBe(false);
      expect(extraction.items[0].confidence).toBe('IDENTIFIED');
      expect(extraction.items[0].batchStatus).toBe('VALID');
    });

    it('extrai lote começando com zero preservando os zeros à esquerda como string', () => {
      const doc = makeRawDoc([
        'Nome do Profissional', 'Dr. Teste',
        'Codigo do produto', 'PR-02',
        'Descricao do produto', 'Item Teste Zero',
        'Numero do lote', '012345',
        'Quantidade', '1',
        'Descricao da ocorrencia', 'Ocorrencia teste para lote iniciando com zero.',
      ]);
      const extraction = parseOutlookFormsDocument(doc);
      expect(extraction.items[0].batch).toBe('012345');
      expect(typeof extraction.items[0].batch).toBe('string');
      expect(extraction.items[0].batch.startsWith('0')).toBe(true);
      expect(extraction.items[0].requiresReview).toBe(false);
      expect(extraction.items[0].batchStatus).toBe('VALID');
    });

    it('remove separador de milhar quando inequívoco do mesmo lote', () => {
      const doc = makeRawDoc([
        'Nome do Profissional', 'Dr. Teste',
        'Codigo do produto', 'PR-03',
        'Descricao do produto', 'Item Separador',
        'Numero do lote', '146.157',
        'Quantidade', '1',
        'Descricao da ocorrencia', 'Ocorrencia teste para separador de milhar.',
      ]);
      const extraction = parseOutlookFormsDocument(doc);
      expect(extraction.items[0].batch).toBe('146157');
      expect(extraction.items[0].requiresReview).toBe(false);
      expect(extraction.items[0].batchStatus).toBe('VALID');
    });

    it('trata ausência de lote mantendo campo vazio e exibindo aviso padronizado', () => {
      const doc = makeRawDoc([
        'Nome do Profissional', 'Dr. Teste',
        'Codigo do produto', 'PR-04',
        'Descricao do produto', 'Item Sem Lote',
        'Numero do lote', '-',
        'Quantidade', '1',
        'Descricao da ocorrencia', 'Ocorrencia teste sem lote informado.',
      ]);
      const extraction = parseOutlookFormsDocument(doc);
      expect(extraction.items[0].batch).toBe('');
      expect(extraction.items[0].batchNotice).toBe('O lote não foi informado no documento.');
      expect(extraction.items[0].requiresReview).toBe(false);
      expect(extraction.items[0].batchStatus).toBe('EMPTY');
    });

    it('solicita revisão e preserva o trecho de origem para valor ambíguo ou diferente de 6 dígitos', () => {
      const doc = makeRawDoc([
        'Nome do Profissional', 'Dr. Teste',
        'Codigo do produto', 'PR-05',
        'Descricao do produto', 'Item Ambíguo',
        'Numero do lote', '22,278',
        'Quantidade', '1',
        'Descricao da ocorrencia', 'Ocorrencia teste com lote ambiguo 22,278.',
      ]);
      const extraction = parseOutlookFormsDocument(doc);
      expect(extraction.items[0].batch).toBe('');
      expect(extraction.items[0].requiresReview).toBe(true);
      expect(extraction.items[0].confidence).toBe('REVIEW_REQUIRED');
      expect(extraction.items[0].sourceSnippet).toBe('22,278');
      expect(extraction.items[0].warning).toContain('22,278');
      expect(extraction.items[0].batchStatus).toBe('AMBIGUOUS');
    });

    it('detecta múltiplos lotes sem concatená-los', () => {
      const doc = makeRawDoc([
        'Nome do Profissional', 'Dr. Teste',
        'Codigo do produto', 'PR-06',
        'Descricao do produto', 'Item Multiplos Lotes',
        'Numero do lote', '146157 / 146158',
        'Quantidade', '2',
        'Descricao da ocorrencia', 'Ocorrencia teste com multiplos lotes 146157 / 146158.',
      ]);
      const extraction = parseOutlookFormsDocument(doc);
      expect(extraction.items[0].batch).toBe('');
      expect(extraction.items[0].requiresReview).toBe(true);
      expect(extraction.items[0].batchCandidates).toEqual(['146157', '146158']);
      expect(extraction.items[0].sourceSnippet).toBe('146157 / 146158');
      expect(extraction.items[0].warning).toContain('Múltiplos lotes');
      expect(extraction.items[0].batchStatus).toBe('MULTIPLE');
    });
  });


  it('correctly handles the three production documents using anonymized synthetic fixtures', async () => {
    // 1. Juliana synthetic fixture: Produto 21623, qtd 1, lote 134597, NF 000865874, Cliente A01482
    const julianaText = `
Outlook
Dra. Juliana Teste - Formulário preenchido - Reclamação de cliente Componentes Protéticos
De Contato Implacil Osstem <sac.teste@example.com>
Data Qui, 20/08/2026 16:51
Para Serviço De Atendimento Ao Consumidor SAC <sac.teste@example.com>
Nome do Profissional
Dra. Juliana Teste
CRO/UF
000000/SP
CPF / CNPJ
000.000.000-00
Código do cliente
A01482
Telefone
(11) 90000-0000
E-mail
juliana.teste@example.com
Código do produto
21623
Descrição do produto
Transfer cônico estético mold aberta
Número do lote
134597
Quantidade
1
Descrição da ocorrência
A representante não prestou atenção e fez o pedido do componente errado
Qual foi o ocorrido?
Outros
Faça aqui o envio de radiografias ou imagens do produto
IMG_2858.jpeg
Digite aqui o número da Nota Fiscal
000865874
`;
    const julianaInterpreted = interpretDocumentText(julianaText);
    const julianaMatched = await matchAndScoreFields(julianaInterpreted, 'PDF', false);
    const julianaSanitized = sanitizeDocumentImportPayload(julianaMatched);

    expect(julianaSanitized.customerName.value).toBe('Juliana Teste');
    expect(julianaSanitized.invoiceNumber.value).toBe('000865874');
    expect(julianaSanitized.items.length).toBe(1);
    expect(julianaSanitized.items[0].code).toBe('21623');
    expect(julianaSanitized.items[0].quantity).toBe(1);
    expect(julianaSanitized.items[0].batch).toBe('134597');
    expect(julianaSanitized.items[0].batchStatus).toBe('VALID');
    expect(julianaSanitized.suggestedReason).toBeUndefined(); // DOES NOT suggest Embalagem danificada
    expect(julianaSanitized.referencedFiles.length).toBe(1);
    expect(julianaSanitized.referencedFiles[0].name).toBe('IMG_2858.jpeg');
    expect(julianaSanitized.referencedFiles[0].attached).toBe(false);
    expect(julianaSanitized.referencedFiles[0].isMasked).toBe(false);

    // 2. Marina synthetic fixture: Produto 22274, qtd 2, lote 139,537 -> 139537, NF 000000000 flagged for review
    // Referenced files contain patient identifying names and birth dates -> must appear entirely as '***'
    const marinaText = `
Outlook
Dra. Marina Teste - Formulário preenchido - Reclamação de cliente Implantes
Data Qua, 19/08/2026 17:33
Nome do Profissional
Dra. Marina Teste
Código do cliente
A08608
Código do produto
22274
Descrição do produto
IMPLANTE UN IIICONE MORSE AR 3,5X07
Número do lote
139,537
Quantidade
2
Descrição da ocorrência
NO DIA 13/03/2025 PACIENTE FOI SUBMETIDO A CIRUGIA...
Qual foi o ocorrido?
Não osseointegração
Faça aqui o envio de radiografias ou imagens do produto
16-05-2025-Paciente-Teste-Ficticio-16-12-19621.jpeg
09-01-2026-Paciente-Teste-Ficticio-16-12-1962-11.jpeg
Digite aqui o número da Nota Fiscal
000000000
`;
    const marinaInterpreted = interpretDocumentText(marinaText);
    const marinaMatched = await matchAndScoreFields(marinaInterpreted, 'PDF', false);
    const marinaSanitized = sanitizeDocumentImportPayload(marinaMatched);

    expect(marinaSanitized.items[0].code).toBe('22274');
    expect(marinaSanitized.items[0].quantity).toBe(2);
    expect(marinaSanitized.items[0].batch).toBe('139537');
    expect(marinaSanitized.items[0].batchStatus).toBe('VALID');
    expect(marinaSanitized.invoiceNumber.value).toBe('000000000');
    expect(marinaSanitized.invoiceNumber.requiresReview).toBe(true);
    expect(marinaSanitized.invoiceNumber.confidence).toBe('REVIEW_REQUIRED');
    expect(marinaSanitized.candidateReferences.some((r: any) => r.type === 'INVOICE' && r.confidence === 'IDENTIFIED')).toBe(false);
    expect(marinaSanitized.referencedFiles.length).toBe(2);
    expect(marinaSanitized.referencedFiles[0].attached).toBe(false);
    // Point 1: File names with personal identification appear entirely as '***'
    expect(marinaSanitized.referencedFiles[0].name).toBe('***');
    expect(marinaSanitized.referencedFiles[0].isMasked).toBe(true);
    expect(marinaSanitized.referencedFiles[0].isSensitive).toBe(true);
    expect(marinaSanitized.referencedFiles[0].sensitiveCategory).toBe('CLINICAL');
    expect(marinaSanitized.referencedFiles[1].name).toBe('***');
    expect(marinaSanitized.referencedFiles[1].isMasked).toBe(true);
    expect(marinaSanitized.referencedFiles[1].isSensitive).toBe(true);
    expect(marinaSanitized.referencedFiles[1].sensitiveCategory).toBe('CLINICAL');

    // 3. Jeniffer synthetic fixture: 2 items (qty 1 & 2), mixed code not corrected by supposition, lote 22,278 ambiguous, lote 146157 on smaller implants
    const jenifferText = `
Outlook
Dra. Jeniffer Teste - Formulário preenchido - Reclamação de cliente Implantes
Data Sex, 21/08/2026 17:20
Nome do Profissional
Dra. Jeniffer Teste
Código do cliente
?
Código do produto
1implante 222278 2 implantes 22276
Descrição do produto
1 implante CM 3.5x11 e 2 implantes 3,5x9
Número do lote
22,278
Quantidade
3
Descrição da ocorrência
Foi feita cirurgia de 1 implante CM 3.5x11 região do 24 sem carga imediata e com 3 meses ao reabrir o mesmo estava sem isseointegração alguma.
Foi feita cirurgia de 2 implantes CM3.5x9 (lote 146157) região do 12 e 11 sem carga imediata e com 3 meses ao reabrir os mesmos estavam sem osseointegracao alguma.
Qual foi o ocorrido?
Não osseointegração
Digite aqui o número da Nota Fiscal
000786997
`;
    const jenifferInterpreted = interpretDocumentText(jenifferText);
    const jenifferMatched = await matchAndScoreFields(jenifferInterpreted, 'PDF', false);
    const jenifferSanitized = sanitizeDocumentImportPayload(jenifferMatched);

    expect(jenifferSanitized.candidateReferences.some((r: any) => r.value === '?')).toBe(false);
    expect(jenifferSanitized.invoiceNumber.value).toBe('000786997');
    expect(jenifferSanitized.items.length).toBe(2);
    // Item 1: 1 implante CM 3.5x11, code 222278 preserved, lote 22,278 ambiguous
    expect(jenifferSanitized.items[0].code).toBe('222278');
    expect(jenifferSanitized.items[0].quantity).toBe(1);
    expect(jenifferSanitized.items[0].batch).toBe('');
    expect(jenifferSanitized.items[0].batchStatus).toBe('AMBIGUOUS');
    expect(jenifferSanitized.items[0].requiresReview).toBe(true);
    // Item 2: 2 implantes 3,5x9, code 22276, lote 146157 valid
    expect(jenifferSanitized.items[1].code).toBe('22276');
    expect(jenifferSanitized.items[1].quantity).toBe(2);
    expect(jenifferSanitized.items[1].batch).toBe('146157');
    expect(jenifferSanitized.items[1].batchStatus).toBe('VALID');
    expect(jenifferSanitized.items[1].requiresReview).toBe(false);

    // Point 2: Do NOT generate a generic "Lote: 146157" in internalNote when batch belongs only to one item.
    // The batch resides exclusively in item 2 (items[1].batch = '146157').
    expect(jenifferSanitized.internalNote?.value || '').not.toContain('Lote: 146157');
    expect(jenifferSanitized.internalNote?.value || '').not.toContain('Lote:');
  });

});
