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
});
