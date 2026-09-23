import type { FormExtractionResult, RawDocumentText } from './document-extraction.types.js';
import { parsePdfDocument } from './pdf-text.parser.js';
import { parseXlsxDocument } from './xlsx.parser.js';
import { parseImageDocument } from './image-ocr.parser.js';
import { interpretDocumentText } from './form-interpreter.js';
import { matchAndScoreFields } from './field-matcher.js';

import { validateOoxmlZip } from './ooxml-validator.js';

export function detectDocumentFormat(buffer: Buffer, filename: string): 'PDF' | 'IMAGE' | 'XLSX' {
  if (buffer.length < 4) {
    throw new Error('Arquivo muito pequeno ou vazio para identificação.');
  }

  // PDF magic bytes: %PDF-
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return 'PDF';
  }

  // PNG magic bytes: \x89PNG
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'IMAGE';
  }

  // JPEG magic bytes: \xFF\xD8\xFF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'IMAGE';
  }

  // XLSX magic bytes: PK\x03\x04 (ZIP) and filename ends with .xlsx
  if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    if (filename.toLowerCase().endsWith('.xlsx')) {
      const validation = validateOoxmlZip(buffer);
      if (!validation.valid) {
        throw new Error(validation.error || 'Planilha XLSX inválida ou com formato corrompido.');
      }
      return 'XLSX';
    }
  }

  throw new Error('Formato de arquivo não suportado. Envie um arquivo PDF, imagem (PNG, JPG) ou planilha (XLSX).');
}

export async function extractDocumentData(
  buffer: Buffer,
  originalFilename: string
): Promise<FormExtractionResult> {
  const format = detectDocumentFormat(buffer, originalFilename);

  let raw: RawDocumentText;

  switch (format) {
    case 'PDF':
      raw = await parsePdfDocument(buffer);
      break;
    case 'XLSX':
      raw = await parseXlsxDocument(buffer);
      break;
    case 'IMAGE':
      raw = await parseImageDocument(buffer);
      break;
    default:
      throw new Error('Formato não suportado.');
  }

  const interpreted = interpretDocumentText(raw);
  return await matchAndScoreFields(interpreted, format, Boolean(raw.isScanned && format === 'PDF'));
}
