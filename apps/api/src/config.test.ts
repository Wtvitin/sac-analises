import { describe, expect, it } from 'vitest';
import { validateEnvironment } from './config.js';

describe('environment configuration', () => {
  it('requires database and signing configuration', () => {
    expect(() => validateEnvironment({})).toThrow(/DATABASE_URL, JWT_SECRET/);
  });

  it('accepts a configurable PostgreSQL URL without hardcoded production values', () => {
    expect(validateEnvironment({ DATABASE_URL: 'postgresql://example.invalid/db', JWT_SECRET: 'test-only', PORT: '3333' })).toEqual({ port: 3333 });
  });
});
