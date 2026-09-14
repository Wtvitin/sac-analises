import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
export const MAX_ATTACHMENT_COUNT = 5;
export const ALLOWED_ATTACHMENT_TYPES = new Map([
  ['application/pdf', '.pdf'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
]);

export type AttachmentUpload = { originalname: string; mimetype: string; size: number; buffer: Buffer };
export type StoredAttachment = { originalName: string; mimeType: string; sizeBytes: number; storageKey: string };

export class AttachmentStorageError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) { super(message); }
}

export interface AttachmentStorage {
  save(files: AttachmentUpload[]): Promise<StoredAttachment[]>;
  remove(files: StoredAttachment[]): Promise<void>;
}

function safeOriginalName(value: string) {
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return name.slice(0, 180) || 'arquivo';
}

class LocalAttachmentStorage implements AttachmentStorage {
  private readonly directory: string;

  constructor() {
    const configured = process.env.LOCAL_UPLOAD_DIR?.trim();
    this.directory = configured ? resolve(configured) : fileURLToPath(new URL('../../../../data/uploads/', import.meta.url));
  }

  async save(files: AttachmentUpload[]) {
    if (files.length > MAX_ATTACHMENT_COUNT) throw new AttachmentStorageError('TOO_MANY_ATTACHMENTS', `Envie no máximo ${MAX_ATTACHMENT_COUNT} arquivos.`);
    await mkdir(this.directory, { recursive: true });
    const stored: StoredAttachment[] = [];
    try {
      for (const file of files) {
        const extension = ALLOWED_ATTACHMENT_TYPES.get(file.mimetype);
        if (!extension) throw new AttachmentStorageError('INVALID_ATTACHMENT_TYPE', 'Envie somente arquivos PDF, JPG, JPEG ou PNG.');
        if (file.size <= 0 || file.size > MAX_ATTACHMENT_SIZE) throw new AttachmentStorageError('INVALID_ATTACHMENT_SIZE', 'Cada arquivo deve possuir até 10 MB.');
        const storageKey = `${randomUUID()}${extension}`;
        await writeFile(resolve(this.directory, storageKey), file.buffer, { flag: 'wx' });
        stored.push({ originalName: safeOriginalName(file.originalname || `arquivo${extname(extension)}`), mimeType: file.mimetype, sizeBytes: file.size, storageKey });
      }
      return stored;
    } catch (error) {
      await this.remove(stored);
      throw error;
    }
  }

  async remove(files: StoredAttachment[]) {
    await Promise.all(files.map(file => unlink(resolve(this.directory, file.storageKey)).catch(() => undefined)));
  }
}

let localStorage: AttachmentStorage | undefined;
export function getAttachmentStorage(): AttachmentStorage {
  const driver = process.env.UPLOAD_STORAGE_DRIVER?.trim() || 'local';
  if (driver !== 'local') throw new AttachmentStorageError('STORAGE_DRIVER_UNAVAILABLE', 'O armazenamento de evidências não está disponível.', 503);
  if (process.env.NODE_ENV === 'production' && !process.env.LOCAL_UPLOAD_DIR) throw new AttachmentStorageError('STORAGE_NOT_CONFIGURED', 'Configure o armazenamento de evidências do ambiente.', 503);
  return localStorage ??= new LocalAttachmentStorage();
}
