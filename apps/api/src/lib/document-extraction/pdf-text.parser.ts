import { createRequire } from 'node:module';
import type { RawDocumentText } from './document-extraction.types.js';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

export const MAX_PDF_PAGES = 10;

export async function parsePdfDocument(buffer: Buffer): Promise<RawDocumentText> {
  const data = await pdfParse(buffer, {
    max: MAX_PDF_PAGES + 1,
  });

  if (data.numpages > MAX_PDF_PAGES) {
    throw new Error(`O documento possui ${data.numpages} páginas. O limite para importação é de ${MAX_PDF_PAGES} páginas.`);
  }

  const text = (data.text || '').trim();
  const isScanned = text.length < 20;

  const warnings: string[] = [];
  if (isScanned) {
    warnings.push('O documento não possui camada de texto editável ou é um PDF digitalizado. As evidências foram preservadas para preenchimento manual.');
  }

  return {
    text,
    format: 'PDF',
    numPages: data.numpages,
    isScanned,
    warnings,
  };
}
