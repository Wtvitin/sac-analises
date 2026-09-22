import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./lib/database-health.js', () => ({ checkDatabaseHealth: vi.fn().mockResolvedValue({ connected: true, schemaReady: true }) }));
import { app } from './app.js';

let server: Server | undefined;
async function health(origin: string) { server = app.listen(0); const address = server.address(); if (!address || typeof address === 'string') throw new Error('test server unavailable'); return fetch(`http://127.0.0.1:${address.port}/health`, { headers: { Origin: origin } }); }

describe('endurecimento HTTP', () => {
  afterEach(async () => { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; });
  it('aceita a origem explícita com credenciais e remove X-Powered-By', async () => { const response = await health('http://localhost:5173'); expect(response.status).toBe(200); expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173'); expect(response.headers.get('access-control-allow-credentials')).toBe('true'); expect(response.headers.get('x-powered-by')).toBeNull(); });
  it('rejeita origem diferente com resposta genérica', async () => { const response = await health('https://untrusted.example.test'); expect(response.status).toBe(403); await expect(response.json()).resolves.toEqual({ error: { code: 'ORIGIN_REJECTED', message: 'Origem não autorizada.' } }); });
});
