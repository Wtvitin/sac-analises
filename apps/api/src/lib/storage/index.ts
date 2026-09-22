import { LocalStorageProvider } from './local-storage.provider.js';
import { S3StorageProvider, type S3StorageConfig } from './s3-storage.provider.js';
import { AttachmentStorageError } from './file-validation.js';
import type { StorageProvider } from './storage.types.js';

let defaultStorageProvider: StorageProvider | undefined;

export function getStorageProvider(): StorageProvider {
  if (defaultStorageProvider) return defaultStorageProvider;

  const driver = (process.env.STORAGE_DRIVER || process.env.UPLOAD_STORAGE_DRIVER || 'local').toLowerCase().trim();

  if (driver === 'local') {
    if (process.env.NODE_ENV === 'production' && !process.env.LOCAL_UPLOAD_DIR && !process.env.UPLOAD_DIR) {
      throw new AttachmentStorageError(
        'STORAGE_NOT_CONFIGURED',
        'Configure o diretório de armazenamento de evidências (LOCAL_UPLOAD_DIR) em produção.',
        503
      );
    }
    defaultStorageProvider = new LocalStorageProvider();
    return defaultStorageProvider;
  }

  if (driver === 's3') {
    const bucket = process.env.S3_BUCKET?.trim() || '';
    const region = process.env.S3_REGION?.trim() || '';
    const config: S3StorageConfig = {
      bucket,
      region,
      endpoint: process.env.S3_ENDPOINT?.trim(),
      accessKeyId: process.env.S3_ACCESS_KEY_ID?.trim(),
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY?.trim(),
    };
    defaultStorageProvider = new S3StorageProvider(config);
    return defaultStorageProvider;
  }

  throw new AttachmentStorageError(
    'STORAGE_DRIVER_UNAVAILABLE',
    `Provedor de armazenamento "${driver}" não é suportado.`,
    503
  );
}

export function resetStorageProvider(): void {
  defaultStorageProvider = undefined;
}

export * from './storage.types.js';
export * from './file-validation.js';
export * from './local-storage.provider.js';
export * from './s3-storage.provider.js';
