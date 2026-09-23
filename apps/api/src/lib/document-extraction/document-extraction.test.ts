import { describe, expect, it } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import { detectDocumentFormat, extractDocumentData } from './document-extraction.provider.js';
import { interpretDocumentText } from './form-interpreter.js';
import { parsePdfDocument } from './pdf-text.parser.js';
import { parseXlsxDocument } from './xlsx.parser.js';
import { parseImageDocument } from './image-ocr.parser.js';
import { validateOoxmlZip } from './ooxml-validator.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs');

// Helper to create a minimal valid PDF with specified text stream
function createTextualPdf(textLines: string[]): Buffer {
  const contentStream = [
    'BT',
    '/F1 12 Tf',
    '72 700 Td',
    ...textLines.map((line, idx) => (idx === 0 ? `(${line}) Tj` : `0 -20 Td (${line}) Tj`)),
    'ET',
  ].join('\n');

  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>
endobj
4 0 obj
<< /Length ${contentStream.length} >>
stream
${contentStream}
endstream
endobj
xref
0 5
0000000000 65535 f
trailer
<< /Size 5 /Root 1 0 R >>
startxref
${200 + contentStream.length}
%%EOF`;

  return Buffer.from(pdf);
}

// Helper to create an empty/scanned PDF without text stream
function createScannedPdf(): Buffer {
  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 0 >>
stream
endstream
endobj
xref
0 5
0000000000 65535 f
trailer
<< /Size 5 /Root 1 0 R >>
startxref
250
%%EOF`;

  return Buffer.from(pdf);
}

// Minimal valid PNG buffer
const minimalPng = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

describe('Document Extraction - Format Detection and Security', () => {
  it('detects PDF format from magic bytes %PDF-', () => {
    const pdfBuf = Buffer.from('%PDF-1.5 test content');
    expect(detectDocumentFormat(pdfBuf, 'form.pdf')).toBe('PDF');
  });

  it('detects PNG format from magic bytes', () => {
    const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    expect(detectDocumentFormat(pngBuf, 'screenshot.png')).toBe('IMAGE');
  });

  it('detects JPEG format from magic bytes', () => {
    const jpgBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(detectDocumentFormat(jpgBuf, 'photo.jpeg')).toBe('IMAGE');
  });

  it('rejects unsupported files or executables', () => {
    const exeBuf = Buffer.from([0x4d, 0x5a, 0x90, 0x00]); // MZ
    expect(() => detectDocumentFormat(exeBuf, 'malware.exe')).toThrow(/não suportado/i);
  });

  it('rejects empty or very small files', () => {
    expect(() => detectDocumentFormat(Buffer.from([]), 'empty.pdf')).toThrow(/vazio/i);
  });
});

describe('Document Extraction - OOXML and ZIP Bomb Defense', () => {
  it('accepts legitimate OOXML Excel spreadsheets', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('SAC');
    ws.addRow(['Atendimento', 'AT-001']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const result = validateOoxmlZip(buffer);
    expect(result.valid).toBe(true);
    expect(result.entryCount).toBeGreaterThan(0);
    expect(detectDocumentFormat(buffer, 'teste.xlsx')).toBe('XLSX');
  });

  it('rejects non-Excel ZIP files renamed to .xlsx before ExcelJS', () => {
    const fakeZip = Buffer.from([
      0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x21, 0x00, 0x31, 0x5e, 0x4e, 0x8a, 0x05, 0x00,
      0x00, 0x00, 0x05, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00,
      0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x2e, 0x74, 0x78, 0x74, 0x77,
      0x6f, 0x72, 0x6c, 0x64, 0x50, 0x4b, 0x01, 0x02, 0x14, 0x03,
      0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x21, 0x00,
      0x31, 0x5e, 0x4e, 0x8a, 0x05, 0x00, 0x00, 0x00, 0x05, 0x00,
      0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x20, 0x80, 0xa4, 0x81, 0x00, 0x00, 0x00, 0x00,
      0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x2e, 0x74, 0x78, 0x74, 0x50,
      0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01,
      0x00, 0x37, 0x00, 0x00, 0x00, 0x2b, 0x00, 0x00, 0x00, 0x00,
      0x00,
    ]);

    const result = validateOoxmlZip(fakeZip);
    expect(result.valid).toBe(false);
    expect(() => detectDocumentFormat(fakeZip, 'documento.xlsx')).toThrow(/não é uma planilha Excel legítima|Assinatura inválida|Estrutura ZIP/i);
  });

  it('rejects ZIP with excessive entries', () => {
    // Construct fake EOCD with 999 entries
    const fakeEocd = Buffer.alloc(22);
    fakeEocd[0] = 0x50; fakeEocd[1] = 0x4b; fakeEocd[2] = 0x05; fakeEocd[3] = 0x06;
    fakeEocd.writeUInt16LE(999, 10); // totalEntries = 999
    const buf = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), fakeEocd]);

    const result = validateOoxmlZip(buf);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('excede o limite de segurança');
  });
});

describe('Document Extraction - Real Binary PDF Parsing', () => {
  it('extracts text from real binary PDF using PDFParse v2', async () => {
    const pdfBuffer = createTextualPdf([
      'Atendimento: AT-2026-9901',
      'Cliente: Acme Industrial S.A.',
      'Pedido: 445566',
      'Observacao: Entrega com atraso e produtos violados',
    ]);

    const result = await parsePdfDocument(pdfBuffer);
    expect(result.format).toBe('PDF');
    expect(result.isScanned).toBe(false);
    expect(result.text).toContain('Atendimento: AT-2026-9901');
    expect(result.text).toContain('Cliente: Acme Industrial S.A.');
    expect(result.text).toContain('Pedido: 445566');
  });

  it('rasterizes scanned PDF pages and triggers OCR', async () => {
    const scannedBuffer = createScannedPdf();
    const result = await parsePdfDocument(scannedBuffer);

    expect(result.format).toBe('PDF');
    expect(result.isScanned).toBe(true);
    expect(result.warnings.some(w => w.includes('digitalizado') || w.includes('rasterizadas'))).toBe(true);
  });
});

describe('Document Extraction - Offline Tesseract OCR', () => {
  it('executes OCR on images using offline model without external network calls', async () => {
    let networkBlockedCalls = 0;
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = () => {
      networkBlockedCalls++;
      return Promise.reject(new Error('Network access forbidden in offline test'));
    };

    try {
      const result = await parseImageDocument(minimalPng);
      expect(result.format).toBe('IMAGE');
      expect(result.isScanned).toBe(true);
      expect(networkBlockedCalls).toBe(0);
    } finally {
      (globalThis as any).fetch = origFetch;
    }
  });
});

describe('Document Extraction - End-to-End Extraction on Binary Buffers', () => {
  it('extracts full structured fields from a textual PDF buffer', async () => {
    const pdfBuffer = createTextualPdf([
      'Atendimento: AT-77665',
      'Cliente: Metalurgica Progresso Ltda',
      'Contato: Carlos Alberto',
      'Data: 22/09/2026',
      'Hora inicial: 09:30',
      'Comunicacao: WhatsApp',
      'Pedido: 887766',
      'Observacao do atendimento: Falha tecnica na valvula hidraulica',
    ]);

    const result = await extractDocumentData(pdfBuffer, 'formulario.pdf');
    expect(result.externalTicket.value).toBe('AT-77665');
    expect(result.externalTicket.confidence).toBe('IDENTIFIED');
    expect(result.customerName.value).toBe('Metalurgica Progresso Ltda');
    expect(result.orderNumber.value).toBe('887766');
    expect(result.format).toBe('PDF');
  });

  it('extracts full structured fields from an XLSX buffer', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Formulário');
    ws.addRow(['Atendimento', 'SAC-9900']);
    ws.addRow(['Cliente', 'Supermercado Progresso']);
    ws.addRow(['Pedido', '123987']);
    ws.addRow(['Observação', 'Caixa com amassados visíveis']);
    ws.addRow([]);
    ws.addRow(['Código', 'Descrição', 'Lote', 'Quantidade']);
    ws.addRow(['IT-01', 'Produto Teste A', 'Lote 1', '10']);

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const result = await extractDocumentData(buffer, 'dados.xlsx');

    expect(result.externalTicket.value).toBe('SAC-9900');
    expect(result.customerName.value).toBe('Supermercado Progresso');
    expect(result.orderNumber.value).toBe('123987');
    expect(result.items.length).toBe(1);
    expect(result.items[0].code).toBe('IT-01');
    expect(result.items[0].quantity).toBe(10);
  });
});

describe('Document Extraction - Form Interpretation and Business Fields', () => {
  it('extracts standard form fields from structured text', () => {
    const text = `
      Atendimento: AT-98765
      Cliente: Indústria Metalúrgica Alfa Ltda
      Contato: João da Silva
      Telefone: (11) 98765-4321
      Cidade: Campinas
      Endereço: Rua das Flores, 120
      Bairro: Centro
      Data: 14/09/2026
      Hora inicial: 10:15
      Comunicação: WhatsApp
      Pedido: 554433
      Observação do atendimento: Cliente informa que recebeu produtos com avaria na embalagem.
      Produto: Tubo de Cobre 15mm
      Produto: Válvula de Retenção
    `;

    const result = interpretDocumentText({
      text,
      format: 'PDF',
      warnings: [],
    });

    expect(result.externalTicket.value).toBe('AT-98765');
    expect(result.externalTicket.confidence).toBe('IDENTIFIED');

    expect(result.customerName.value).toBe('Indústria Metalúrgica Alfa Ltda');
    expect(result.customerName.confidence).toBe('IDENTIFIED');

    expect(result.customerContact?.value).toContain('João da Silva');
    expect(result.customerContact?.value).toContain('(11) 98765-4321');

    expect(result.openedAt.value).toBe('2026-09-14T10:15');
    expect(result.openedAt.confidence).toBe('IDENTIFIED');

    expect(result.channelName?.value).toBe('WhatsApp');
    expect(result.channelName?.confidence).toBe('REVIEW_REQUIRED');

    expect(result.orderNumber.value).toBe('554433');
    expect(result.orderNumber.confidence).toBe('IDENTIFIED');

    expect(result.description.value).toContain('Cliente informa que recebeu produtos');

    expect(result.items.length).toBe(2);
    expect(result.items[0].description).toBe('Tubo de Cobre 15mm');
    expect(result.items[1].description).toBe('Válvula de Retenção');
  });

  it('detects order number located in free text inside description', () => {
    const text = `
      Atendimento: 2026-001
      Cliente: Farmácia Saúde e Vida
      Data: 15/09/2026
      Observação: Entrega divergente relativa ao pedido 333681 faturado ontem pela filial.
    `;

    const result = interpretDocumentText({
      text,
      format: 'PDF',
      warnings: [],
    });

    expect(result.orderNumber.value).toBe('333681');
    expect(result.orderNumber.confidence).toBe('REVIEW_REQUIRED');
    expect(result.orderNumber.sourceSnippet).toContain('pedido 333681');
    expect(result.orderNumber.requiresReview).toBe(true);
  });

  it('marks multiple order numbers for explicit review without guessing', () => {
    const text = `
      Cliente: Distribuidora Sol
      Observação: Dúvida se a reclamação é do pedido 1001 ou pedido 2002 que chegaram juntos.
    `;

    const result = interpretDocumentText({
      text,
      format: 'PDF',
      warnings: [],
    });

    expect(result.orderNumber.confidence).toBe('REVIEW_REQUIRED');
    expect(result.orderNumber.requiresReview).toBe(true);
    expect(result.orderNumber.warning).toContain('Múltiplos números de pedido');
  });
});
