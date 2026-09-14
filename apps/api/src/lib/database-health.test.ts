import { describe, expect, it, vi } from 'vitest';
import { checkDatabaseHealth } from './database-health.js';

describe('database health', () => {
  it('reports a successful database probe', async () => {
    expect(await checkDatabaseHealth(vi.fn().mockResolvedValue([{ ready: true }]))).toEqual({ connected: true, schemaReady: true });
  });

  it('handles connection failures without exposing their message', async () => {
    expect(await checkDatabaseHealth(vi.fn().mockRejectedValue(new Error('secret connection value')))).toEqual({ connected: false, schemaReady: false });
  });

  it('does not wait indefinitely for a connection', async () => {
    expect(await checkDatabaseHealth(() => new Promise(() => undefined), 5)).toEqual({ connected: false, schemaReady: false });
  });

  it('distinguishes a connected database with pending schema', async () => {
    expect(await checkDatabaseHealth(vi.fn().mockResolvedValue([{ ready: false }]))).toEqual({ connected: true, schemaReady: false });
  });
});
