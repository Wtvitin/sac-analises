import { createRequire } from 'node:module';
import type { RawDocumentText } from './document-extraction.types.js';
import { parseImageDocument } from './image-ocr.parser.js';

const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');

export const MAX_PDF_PAGES = 10;

export async function parsePdfDocument(buffer: Buffer): Promise<RawDocumentText> {
  const parser = new PDFParse({ data: buffer });
  const warnings: string[] = [];

  try {
    await parser.load();

    const totalPages = parser.doc ? parser.doc.numPages : 1;
    if (totalPages > MAX_PDF_PAGES) {
      throw new Error(`O documento possui ${totalPages} páginas. O limite para importação é de ${MAX_PDF_PAGES} páginas.`);
    }

    const textResult = await parser.getText();
    const rawText = (textResult?.text || '').trim();
    // Clean pdf-parse page marker tokens (e.g. "-- 1 of 1 --")
    const cleanText = rawText.replace(/--\s*\d+\s*of\s*\d+\s*--/gi, '').trim();

    const isScanned = cleanText.length < 20;

    if (!isScanned) {
      return {
        text: cleanText,
        format: 'PDF',
        numPages: totalPages,
        isScanned: false,
        warnings,
      };
    }

    // Scanned PDF: Rasterize pages into PNG images and perform OCR on each page
    warnings.push('O documento é um PDF digitalizado ou não possui camada de texto. As páginas foram rasterizadas e interpretadas por OCR.');

    let scannedPagesText = '';
    try {
      const screenshots = await parser.getScreenshot({
        imageBuffer: true,
        scale: 1.5,
      });

      const pagesToProcess = Math.min(screenshots.pages.length, MAX_PDF_PAGES);

      for (let i = 0; i < pagesToProcess; i++) {
        const page = screenshots.pages[i];
        if (!page || !page.data || page.data.length === 0) {
          warnings.push(`Página ${i + 1} não pôde ser rasterizada.`);
          continue;
        }

        const pageBuffer = Buffer.from(page.data);
        const pageOcr = await parseImageDocument(pageBuffer);

        if (pageOcr.text) {
          scannedPagesText += (scannedPagesText ? '\n\n' : '') + pageOcr.text;
        }

        if (pageOcr.warnings.length > 0) {
          warnings.push(`Página ${i + 1}: ${pageOcr.warnings.join(' ')}`);
        }
      }
    } catch (renderError: any) {
      warnings.push(`Falha na rasterização do PDF para OCR: ${renderError?.message || 'erro de renderização'}. O formulário foi preservado para preenchimento manual.`);
    }

    return {
      text: scannedPagesText.trim(),
      format: 'PDF',
      numPages: totalPages,
      isScanned: true,
      warnings,
    };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

