import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import {
  AttachmentStorageError,
  sanitizeOriginalName,
  validateFileContent,
} from './file-validation.js';
import type {
  AttachmentUploadInput,
  StorageFileMetadata,
  StorageProvider,
  StorageSaveResult,
} from './storage.types.js';

export class LocalStorageProvider implements StorageProvider {
  readonly providerName = 'local';
  private readonly baseDirectory: string;
  private readonly tempDirectory: string;

  constructor(customDirectory?: string) {
    const configured = customDirectory || process.env.LOCAL_UPLOAD_DIR?.trim() || process.env.UPLOAD_DIR?.trim();
    this.baseDirectory = configured
      ? resolve(configured)
      : fileURLToPath(new URL('../../../../../data/uploads/', import.meta.url));
    this.tempDirectory = resolve(this.baseDirectory, 'temp');
  }

  /**
   * Safely resolves a storage key to an absolute filesystem path,
   * strictly prohibiting path traversal outside the base directory.
   */
  private resolveSafePath(storageKey: string): string {
    if (!storageKey || typeof storageKey !== 'string') {
      throw new AttachmentStorageError('INVALID_STORAGE_KEY', 'Chave de armazenamento inválida.', 400);
    }

    // Prohibit control characters and obvious traversal tokens
    if (/[\u0000-\u001f\u007f]/.test(storageKey) || storageKey.includes('\0')) {
      throw new AttachmentStorageError('PATH_TRAVERSAL_DETECTED', 'Chave de armazenamento ilegítima.', 400);
    }

    // Reject absolute paths and drive letters
    if (storageKey.startsWith('/') || storageKey.startsWith('\\') || /^[a-zA-Z]:/.test(storageKey) || isAbsolute(storageKey)) {
      throw new AttachmentStorageError('PATH_TRAVERSAL_DETECTED', 'Caminho absoluto ou path traversal rejeitado.', 400);
    }

    const resolvedPath = resolve(this.baseDirectory, storageKey);
    const rel = relative(this.baseDirectory, resolvedPath);

    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new AttachmentStorageError('PATH_TRAVERSAL_DETECTED', 'Tentativa de path traversal rejeitada.', 400);
    }

    return resolvedPath;
  }

  async save(file: AttachmentUploadInput): Promise<StorageSaveResult> {
    // 1. Validate file content (magic bytes, MIME, max size, dangerous signatures)
    const detected = validateFileContent(file.buffer, file.mimetype, file.originalname);
    const safeName = sanitizeOriginalName(file.originalname, detected.canonicalExtension);

    // 2. Compute SHA-256 hash
    const hash = createHash('sha256').update(file.buffer).digest('hex');

    // 3. Prepare temporary and final paths
    await mkdir(this.tempDirectory, { recursive: true });
    const tempFileId = randomUUID();
    const tempPath = resolve(this.tempDirectory, `${tempFileId}.tmp`);

    const now = new Date();
    const year = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const storageKey = `attachments/${year}/${month}/${randomUUID()}${detected.canonicalExtension}`;
    const targetPath = this.resolveSafePath(storageKey);

    try {
      // Step A: Write to temporary file with exclusive creation
      await writeFile(tempPath, file.buffer, { flag: 'wx' });

      // Step B: Ensure target directory exists
      await mkdir(dirname(targetPath), { recursive: true });

      // Step C: Atomically promote from temp to destination
      await rename(tempPath, targetPath);

      return {
        storageKey,
        sizeBytes: file.buffer.length,
        sha256: hash,
        mimeType: detected.mimeType,
        originalName: safeName,
        storageProvider: this.providerName,
      };
    } catch (error) {
      // Clean up temp file on failure
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  async openReadStream(storageKey: string): Promise<Readable> {
    const fullPath = this.resolveSafePath(storageKey);
    const fileExists = await this.exists(storageKey);
    if (!fileExists) {
      throw new AttachmentStorageError('ATTACHMENT_FILE_NOT_FOUND', 'Arquivo não encontrado no armazenamento.', 404);
    }
    return createReadStream(fullPath);
  }

  async exists(storageKey: string): Promise<boolean> {
    try {
      const fullPath = this.resolveSafePath(storageKey);
      const s = await stat(fullPath);
      return s.isFile();
    } catch {
      return false;
    }
  }

  async remove(storageKey: string): Promise<void> {
    const fullPath = this.resolveSafePath(storageKey);
    try {
      await unlink(fullPath);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        return;
      }
      throw err;
    }
  }

  async getMetadata(storageKey: string): Promise<StorageFileMetadata | null> {
    const fullPath = this.resolveSafePath(storageKey);
    try {
      const s = await stat(fullPath);
      if (!s.isFile()) return null;
      return {
        storageKey,
        sizeBytes: s.size,
        createdAt: s.birthtime,
      };
    } catch {
      return null;
    }
  }

  /**
   * Helper for administrative maintenance (reading base directory paths).
   */
  getBaseDirectory(): string {
    return this.baseDirectory;
  }

  getTempDirectory(): string {
    return this.tempDirectory;
  }
}
