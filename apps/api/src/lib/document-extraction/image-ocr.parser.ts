import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RawDocumentText } from './document-extraction.types.js';

const require = createRequire(import.meta.url);

export const OCR_TIMEOUT_MS = 15000;

export function getTessdataPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidate1 = resolve(currentDir, '../../../assets/tessdata');
  const candidate2 = resolve(process.cwd(), 'assets/tessdata');
  const candidate3 = resolve(process.cwd(), 'apps/api/assets/tessdata');

  for (const dir of [candidate1, candidate2, candidate3]) {
    if (existsSync(resolve(dir, 'por.traineddata'))) {
      return dir;
    }
  }

  throw new Error('Modelo offline de OCR em português (por.traineddata) não encontrado em assets/tessdata.');
}

export async function parseImageDocument(buffer: Buffer): Promise<RawDocumentText> {
  const warnings: string[] = [];

  if (buffer.length === 0) {
    throw new Error('Arquivo de imagem vazio.');
  }

  let extractedText = '';

  try {
    const { createWorker } = require('tesseract.js');
    const localTessdata = getTessdataPath();

    const workerOptions: Record<string, unknown> = {
      langPath: localTessdata,
      cachePath: localTessdata,
      gzip: false,
      logger: () => {}, // silent
    };

    // Run OCR with a hard timeout of 15 seconds
    const ocrPromise = (async () => {
      const worker = await createWorker('por', 1, workerOptions);
      try {
        await worker.setParameters({
          tessedit_pageseg_mode: '3' as any,
        });
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

