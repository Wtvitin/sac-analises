import { describe, expect, it } from 'vitest';
import { detectDocumentFormat } from './document-extraction.provider.js';
import { interpretDocumentText } from './form-interpreter.js';
import { parseXlsxDocument } from './xlsx.parser.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs');

describe('Document Extraction - Format Detection', () => {
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

  it('detects XLSX format from ZIP magic bytes and extension', () => {
    const xlsxBuf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    expect(detectDocumentFormat(xlsxBuf, 'planilha.xlsx')).toBe('XLSX');
  });

  it('rejects unsupported files or executables', () => {
    const exeBuf = Buffer.from([0x4d, 0x5a, 0x90, 0x00]); // MZ
    expect(() => detectDocumentFormat(exeBuf, 'malware.exe')).toThrow(/não suportado/i);
  });

  it('rejects empty or very small files', () => {
    expect(() => detectDocumentFormat(Buffer.from([]), 'empty.pdf')).toThrow(/vazio/i);
  });
});

describe('Document Extraction - Form Interpretation', () => {
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

  it('parses Excel workbook and extracts table items and fields', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Formulário SAC');
    ws.addRow(['Atendimento', 'SAC-2026-X']);
    ws.addRow(['Cliente', 'Supermercado Central']);
    ws.addRow(['Data', '16/09/2026']);
    ws.addRow(['Observação', 'Caixa amassada no descarregamento']);
    ws.addRow(['Nº Pedido', '987123']);
    ws.addRow([]);
    ws.addRow(['Código', 'Descrição', 'Lote', 'Quantidade', 'Observação']);
    ws.addRow(['PROD-01', 'Arroz Branco 5kg', 'L10', '10', 'Rasgado']);
    ws.addRow(['PROD-02', 'Feijão Preto 1kg', 'L12', '5', 'Molhado']);

    const buffer = await wb.xlsx.writeBuffer();
    const raw = await parseXlsxDocument(Buffer.from(buffer));

    const result = interpretDocumentText(raw);

    expect(result.externalTicket.value).toBe('SAC-2026-X');
    expect(result.customerName.value).toBe('Supermercado Central');
    expect(result.orderNumber.value).toBe('987123');
    expect(result.items.length).toBe(2);
    expect(result.items[0].code).toBe('PROD-01');
    expect(result.items[0].description).toBe('Arroz Branco 5kg');
    expect(result.items[0].quantity).toBe(10);
    expect(result.items[1].code).toBe('PROD-02');
    expect(result.items[1].quantity).toBe(5);
  });
});
