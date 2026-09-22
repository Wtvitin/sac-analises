import type { Readable } from 'node:stream';

export interface StorageSaveResult {
  storageKey: string;
  sizeBytes: number;
  sha256: string;
  mimeType: string;
  originalName: string;
  storageProvider: string;
}

export interface StorageFileMetadata {
  storageKey: string;
  sizeBytes: number;
  sha256?: string;
  mimeType?: string;
  createdAt?: Date;
}

export interface AttachmentUploadInput {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface StorageProvider {
  readonly providerName: string;

  /**
   * Saves an uploaded file through validation, hashing and persistent storage.
   */
  save(file: AttachmentUploadInput): Promise<StorageSaveResult>;

  /**
   * Opens a readable stream for authenticated download.
   */
  openReadStream(storageKey: string): Promise<Readable>;

  /**
   * Verifies existence of an object in storage.
   */
  exists(storageKey: string): Promise<boolean>;

  /**
   * Permanently removes or moves an object to quarantine.
   */
  remove(storageKey: string): Promise<void>;

  /**
   * Retrieves technical file metadata.
   */
  getMetadata(storageKey: string): Promise<StorageFileMetadata | null>;
}
