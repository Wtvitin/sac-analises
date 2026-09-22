import { describe, expect, it } from 'vitest';
import { validateEnvironment } from './config.js';

describe('environment configuration', () => {
  it('requires database and signing configuration', () => {
    expect(() => validateEnvironment({})).toThrow(/DATABASE_URL, JWT_SECRET/);
  });

  it('accepts a configurable PostgreSQL URL without hardcoded production values', () => {
    expect(validateEnvironment({ DATABASE_URL: 'postgresql://example.invalid/db', JWT_SECRET: 'test-only', PORT: '3333' })).toMatchObject({ port: 3333, webOrigin: 'http://localhost:5173', accessTokenMinutes: 15, refreshTokenDays: 30, trustProxy: false, production: false });
  });

  it('rejeita origem curinga e proxy irrestrito', () => {
    expect(() => validateEnvironment({ DATABASE_URL: 'postgresql://example.invalid/db', JWT_SECRET: 'test-only', WEB_ORIGIN: '*' })).toThrow(/WEB_ORIGIN/);
    expect(() => validateEnvironment({ DATABASE_URL: 'postgresql://example.invalid/db', JWT_SECRET: 'test-only', TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
  });

  it('validates storage provider configuration for development and production', () => {
    const devValid = validateEnvironment({
      DATABASE_URL: 'postgresql://example.invalid/db',
      JWT_SECRET: 'test-only',
      STORAGE_DRIVER: 'local',
    });
    expect(devValid.storage).toMatchObject({
      driver: 'local',
      maxFileSize: 10485760,
      maxAttachmentCount: 5,
    });

    // Rejects unsupported driver
    expect(() => validateEnvironment({
      DATABASE_URL: 'postgresql://example.invalid/db',
      JWT_SECRET: 'test-only',
      STORAGE_DRIVER: 'ftp',
    })).toThrow(/STORAGE_DRIVER/);

    // Rejects production local storage without directory
    expect(() => validateEnvironment({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://example.invalid/db',
      JWT_SECRET: 'test-only',
      WEB_ORIGIN: 'https://sac.empresa.com',
      STORAGE_DRIVER: 'local',
      LOCAL_UPLOAD_DIR: '',
    })).toThrow(/LOCAL_UPLOAD_DIR/);

    // Rejects production S3 storage without bucket and region
    expect(() => validateEnvironment({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://example.invalid/db',
      JWT_SECRET: 'test-only',
      WEB_ORIGIN: 'https://sac.empresa.com',
      STORAGE_DRIVER: 's3',
    })).toThrow(/S3_BUCKET e S3_REGION/);
  });
});
