import type { Readable } from 'node:stream';
import { AttachmentStorageError } from './file-validation.js';
import type {
  AttachmentUploadInput,
  StorageFileMetadata,
  StorageProvider,
  StorageSaveResult,
} from './storage.types.js';

export interface S3StorageConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
}

/**
 * Contract and architectural adapter specification for AWS S3, Cloudflare R2 or MinIO.
 * In accordance with Etapa 10 requirements, concrete cloud credentials are not stored in code
 * and external network calls are not initiated during local execution.
 */
export class S3StorageProvider implements StorageProvider {
  readonly providerName = 's3';

  constructor(private readonly config: S3StorageConfig) {
    if (!config.bucket || !config.region) {
      throw new AttachmentStorageError(
        'STORAGE_NOT_CONFIGURED',
        'Configuração do provedor S3 incompleta (bucket e region são obrigatórios).',
        503
      );
    }
  }

  async save(_file: AttachmentUploadInput): Promise<StorageSaveResult> {
    throw new AttachmentStorageError(
      'STORAGE_DRIVER_UNAVAILABLE',
      'O provedor remoto S3 está preparado como especificação arquitetural, mas requer credenciais de ambiente em produção.',
      503
    );
  }

  async openReadStream(_storageKey: string): Promise<Readable> {
    throw new AttachmentStorageError(
      'STORAGE_DRIVER_UNAVAILABLE',
      'O provedor remoto S3 está preparado como especificação arquitetural, mas requer credenciais de ambiente em produção.',
      503
    );
  }

  async exists(_storageKey: string): Promise<boolean> {
    return false;
  }

  async remove(_storageKey: string): Promise<void> {
    // Idempotent
  }

  async getMetadata(_storageKey: string): Promise<StorageFileMetadata | null> {
    return null;
  }
}
