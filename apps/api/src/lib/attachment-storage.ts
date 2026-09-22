import {
  AttachmentStorageError,
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENT_SIZE,
} from './storage/file-validation.js';
import { getStorageProvider } from './storage/index.js';
import type { AttachmentUploadInput } from './storage/storage.types.js';

export { AttachmentStorageError, MAX_ATTACHMENT_COUNT, MAX_ATTACHMENT_SIZE };

export const ALLOWED_ATTACHMENT_TYPES = new Map([
  ['application/pdf', '.pdf'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
]);

export type AttachmentUpload = AttachmentUploadInput;

export interface StoredAttachment {
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  sha256?: string;
  storageProvider?: string;
  authorId?: string | null;
}

export interface AttachmentStorage {
  save(files: AttachmentUpload[], authorId?: string): Promise<StoredAttachment[]>;
  remove(files: StoredAttachment[]): Promise<void>;
}

class DelegatingAttachmentStorage implements AttachmentStorage {
  async save(files: AttachmentUpload[], authorId?: string): Promise<StoredAttachment[]> {
    if (files.length > MAX_ATTACHMENT_COUNT) {
      throw new AttachmentStorageError(
        'TOO_MANY_ATTACHMENTS',
        `Envie no máximo ${MAX_ATTACHMENT_COUNT} arquivos.`
      );
    }

    const provider = getStorageProvider();
    const stored: StoredAttachment[] = [];

    try {
      for (const file of files) {
        const result = await provider.save(file);
        stored.push({
          originalName: result.originalName,
          mimeType: result.mimeType,
          sizeBytes: result.sizeBytes,
          storageKey: result.storageKey,
          sha256: result.sha256,
          storageProvider: result.storageProvider,
          authorId: authorId ?? null,
        });
      }
      return stored;
    } catch (error) {
      // Compensate immediately on any error
      await this.remove(stored);
      throw error;
    }
  }

  async remove(files: StoredAttachment[]): Promise<void> {
    const provider = getStorageProvider();
    await Promise.all(
      files.map(file => provider.remove(file.storageKey).catch(() => undefined))
    );
  }
}

let delegatingStorage: AttachmentStorage | undefined;

export function getAttachmentStorage(): AttachmentStorage {
  return delegatingStorage ??= new DelegatingAttachmentStorage();
}
