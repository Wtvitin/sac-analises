import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RawDocumentText } from './document-extraction.types.js';

const require = createRequire(import.meta.url);

export const OCR_TIMEOUT_MS = 15000;

export async function parseImageDocument(buffer: Buffer): Promise<RawDocumentText> {
  const warnings: string[] = [];

  // Enforce size safeguard (10 MB already enforced by storage/upload limit)
  if (buffer.length === 0) {
    throw new Error('Arquivo de imagem vazio.');
  }

  let extractedText = '';

  try {
    const { createWorker } = require('tesseract.js');

    // Check for local traineddata model path in assets/tessdata
    const localTessdata = resolve(process.cwd(), 'assets/tessdata');
    const localModelExists = existsSync(resolve(localTessdata, 'por.traineddata')) || existsSync(resolve(localTessdata, 'por.traineddata.gz'));

    const workerOptions: Record<string, unknown> = {
      logger: () => {}, // silent
    };

    if (localModelExists) {
      workerOptions.langPath = localTessdata;
      workerOptions.cachePath = localTessdata;
    }

    // Run OCR with a hard timeout of 15 seconds
    const ocrPromise = (async () => {
      const worker = await createWorker('por', 1, workerOptions);
      try {
        const ret = await worker.recognize(buffer);
        return ret?.data?.text || '';
      } finally {
        await worker.terminate().catch(() => {});
      }
    })();

    const timeoutPromise = new Promise<string>((_, reject) => {
      const id = setTimeout(() => {
        clearTimeout(id);
        reject(new Error('OCR_TIMEOUT'));
      }, OCR_TIMEOUT_MS);
    });

    extractedText = await Promise.race([ocrPromise, timeoutPromise]);
  } catch (err: any) {
    if (err?.message === 'OCR_TIMEOUT') {
      warnings.push('O processamento de OCR atingiu o tempo limite de 15 segundos. O arquivo foi preservado para revisão manual.');
    } else {
      warnings.push('Não foi possível extrair o texto da imagem via OCR local. O formulário foi preservado para preenchimento manual.');
    }
  }

  const cleanText = (extractedText || '').trim();

  return {
    text: cleanText,
    format: 'IMAGE',
    isScanned: true,
    warnings,
  };
}
