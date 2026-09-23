import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { prisma } from '../../lib/prisma.js';
import { getStorageProvider, sanitizeOriginalName } from '../../lib/storage/index.js';
import { extractDocumentData, detectDocumentFormat, type FormExtractionResult } from '../../lib/document-extraction/index.js';

export class DocumentImportError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
  }
}

export interface DocumentImportSessionResponse {
  id: string;
  originalName: string;
  format: string;
  status: string;
  extractedData: FormExtractionResult | null;
  error?: string | null;
  expiresAt: string;
  createdAt: string;
}

const ALLOWED_MIMES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream', // Some clients send octet-stream for xlsx/pdf
]);

export async function createDocumentImport(
  file: Express.Multer.File | undefined,
  userId: string
): Promise<DocumentImportSessionResponse> {
  if (!file || !file.buffer || file.buffer.length === 0) {
    throw new DocumentImportError('FILE_EMPTY', 'Selecione um arquivo válido para importação.', 400);
  }

  if (file.buffer.length > 10 * 1024 * 1024) {
    throw new DocumentImportError('FILE_TOO_LARGE', 'O formulário deve ter no máximo 10 MB.', 400);
  }

  // Detect format via magic bytes
  let format: 'PDF' | 'IMAGE' | 'XLSX';
  try {
    format = detectDocumentFormat(file.buffer, file.originalname);
  } catch (err: any) {
    throw new DocumentImportError('INVALID_FORMAT', err?.message || 'Formato de arquivo não suportado.', 400);
  }

  const sha256 = createHash('sha256').update(file.buffer).digest('hex');
  const safeName = sanitizeOriginalName(file.originalname);

  // Generate safe isolated temporary storage key
  const ext = safeName.split('.').pop()?.toLowerCase() || (format === 'PDF' ? 'pdf' : format === 'XLSX' ? 'xlsx' : 'png');
  const tempStorageKey = `temp/imports/${randomUUID()}.${ext}`;

  // Resolve safe storage path and save temp file
  const storage = getStorageProvider();
  const baseDir = (storage as any).getBaseDirectory?.() || process.env.LOCAL_UPLOAD_DIR?.trim() || 'data/uploads';
  const fullTempPath = resolve(baseDir, tempStorageKey);
  await mkdir(dirname(fullTempPath), { recursive: true });
  await writeFile(fullTempPath, file.buffer);

  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  // Extract structured data from document
  let extractedData: FormExtractionResult | null = null;
  let status: 'READY_FOR_REVIEW' | 'FAILED' = 'READY_FOR_REVIEW';
  let extractionError: string | null = null;

  try {
    extractedData = await extractDocumentData(file.buffer, file.originalname);
  } catch (err: any) {
    status = 'FAILED';
    extractionError = err?.message || 'Falha ao processar o documento enviado.';
  }

  // Persist session record in database
  const session = await prisma.documentImport.create({
    data: {
      userId,
      sha256,
      format,
      status,
      storageKey: tempStorageKey,
      originalName: safeName,
      extractedData: (extractedData ? JSON.parse(JSON.stringify(extractedData)) : null),
      error: extractionError,
      expiresAt,
    },
  });

  return {
    id: session.id,
    originalName: session.originalName,
    format: session.format,
    status: session.status,
    extractedData,
    error: session.error,
    expiresAt: session.expiresAt.toISOString(),
    createdAt: session.createdAt.toISOString(),
  };
}

export async function getDocumentImport(
  id: string,
  userId: string,
  userRole: string
): Promise<DocumentImportSessionResponse> {
  const session = await prisma.documentImport.findUnique({
    where: { id },
  });

  if (!session) {
    throw new DocumentImportError('IMPORT_NOT_FOUND', 'Sessão de importação não encontrada.', 404);
  }

  if (session.userId !== userId && userRole !== 'ADMIN') {
    throw new DocumentImportError('FORBIDDEN', 'Você não tem permissão para acessar esta importação.', 403);
  }

  // Check expiration
  if (session.status === 'READY_FOR_REVIEW' && session.expiresAt < new Date()) {
    await prisma.documentImport.update({
      where: { id },
      data: { status: 'EXPIRED' },
    });
    session.status = 'EXPIRED';
  }

  return {
    id: session.id,
    originalName: session.originalName,
    format: session.format,
    status: session.status,
    extractedData: session.extractedData as FormExtractionResult | null,
    error: session.error,
    expiresAt: session.expiresAt.toISOString(),
    createdAt: session.createdAt.toISOString(),
  };
}

export async function cancelDocumentImport(
  id: string,
  userId: string,
  userRole: string
): Promise<{ success: boolean }> {
  const session = await prisma.documentImport.findUnique({
    where: { id },
  });

  if (!session) {
    throw new DocumentImportError('IMPORT_NOT_FOUND', 'Sessão de importação não encontrada.', 404);
  }

  if (session.userId !== userId && userRole !== 'ADMIN') {
    throw new DocumentImportError('FORBIDDEN', 'Você não tem permissão para cancelar esta importação.', 403);
  }

  await prisma.documentImport.update({
    where: { id },
    data: { status: 'CANCELLED' },
  });

  // Clean physical temp file
  const storage = getStorageProvider();
  await storage.remove(session.storageKey).catch(() => {});

  return { success: true };
}

export async function confirmDocumentImport(
  importId: string,
  recordId: string,
  preserveAsAttachment: boolean,
  userId: string
): Promise<void> {
  const session = await prisma.documentImport.findUnique({
    where: { id: importId },
  });

  if (!session || session.userId !== userId || session.status !== 'READY_FOR_REVIEW') {
    return; // Non-blocking if already confirmed or invalid
  }

  await prisma.documentImport.update({
    where: { id: importId },
    data: {
      status: 'CONFIRMED',
      confirmedAt: new Date(),
      recordId,
    },
  });

  const storage = getStorageProvider();

  // If user requested to preserve the imported form as a case attachment
  if (preserveAsAttachment) {
    try {
      const exists = await storage.exists(session.storageKey);
      if (exists) {
        // Read file stream safely
        const stream = await storage.openReadStream(session.storageKey);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        const buffer = Buffer.concat(chunks);

        const now = new Date();
        const year = String(now.getUTCFullYear());
        const month = String(now.getUTCMonth() + 1).padStart(2, '0');
        const ext = session.originalName.split('.').pop()?.toLowerCase() || (session.format === 'PDF' ? 'pdf' : session.format === 'XLSX' ? 'xlsx' : 'png');
        const permanentStorageKey = `attachments/${year}/${month}/${randomUUID()}.${ext}`;

        const baseDir = (storage as any).getBaseDirectory?.() || process.env.LOCAL_UPLOAD_DIR?.trim() || 'data/uploads';
        const fullPermPath = resolve(baseDir, permanentStorageKey);
        await mkdir(dirname(fullPermPath), { recursive: true });
        await writeFile(fullPermPath, buffer);

        const sha256 = createHash('sha256').update(buffer).digest('hex');
        const mimeType = session.format === 'PDF' ? 'application/pdf'
          : session.format === 'XLSX' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'image/png';

        await prisma.attachment.create({
          data: {
            recordId,
            originalName: session.originalName,
            mimeType,
            sizeBytes: buffer.length,
            storageKey: permanentStorageKey,
            storageProvider: storage.providerName || 'local',
            sha256,
            status: 'ACTIVE',
            scanStatus: 'CLEAN',
            authorId: userId,
          },
        });
      }
    } catch (err) {
      console.error('Falha ao promover anexo importado para o chamado:', err);
    }
  }

  // Remove temporary import file
  await storage.remove(session.storageKey).catch(() => {});
}
