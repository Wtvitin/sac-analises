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
    'LOTE-99812',
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
    expect(extraction.items[0].batch).toBe('LOTE-99812');
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
});
