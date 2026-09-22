import express from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ authenticate: vi.fn(), createSession: vi.fn(), revokeRefreshSession: vi.fn(), rotateSession: vi.fn(), revokeAllSessions: vi.fn(), revokeOtherSessions: vi.fn() }));
vi.mock('./auth.service.js', () => ({ ACCESS_REQUEST_MESSAGE: 'Solicitação segura.', AuthError: class extends Error {}, authenticate: mock.authenticate, changeOwnPassword: vi.fn(), getOwnProfile: vi.fn(), requestAccess: vi.fn(), updateOwnProfile: vi.fn() }));
vi.mock('./session.service.js', () => ({ createSession: mock.createSession, revokeAllSessions: mock.revokeAllSessions, revokeOtherSessions: mock.revokeOtherSessions, revokeRefreshSession: mock.revokeRefreshSession, rotateSession: mock.rotateSession }));
import { authRouter } from './auth.routes.js';

let server: Server | undefined;
async function request(path: string, init: RequestInit) {
  const app = express(); app.use(express.json()); app.use('/auth', authRouter);
  server = app.listen(0); const address = server.address(); if (!address || typeof address === 'string') throw new Error('test server unavailable');
  return fetch(`http://127.0.0.1:${address.port}${path}`, init);
}

describe('rotas de sessão', () => {
  beforeEach(() => { vi.clearAllMocks(); process.env.JWT_SECRET = 'test-only-secret'; delete process.env.NODE_ENV; mock.authenticate.mockResolvedValue({ user: { id: 'user-1', tokenVersion: 1 } }); mock.createSession.mockResolvedValue({ accessToken: 'access-test-only', refreshToken: 'refresh-test-only', user: { id: 'user-1', name: 'Pessoa', role: 'ADMIN' } }); });
  afterEach(async () => { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; });

  it('login define cookies HttpOnly, desabilita cache e não retorna tokens no corpo', async () => {
    const response = await request('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'person@example.test', password: 'SenhaSegura123' }) });
    const body = await response.json(); const cookies = response.headers.get('set-cookie') ?? '';
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store'); expect(cookies).toContain('sac_access='); expect(cookies).toContain('sac_refresh='); expect(cookies).toContain('HttpOnly');
    expect(body).toEqual({ data: { user: { id: 'user-1', name: 'Pessoa', role: 'ADMIN' } } }); expect(JSON.stringify(body)).not.toMatch(/access-test|refresh-test|token/i);
  });

  it('logout é idempotente, revoga a sessão encontrada e remove ambos os cookies', async () => {
    const response = await request('/auth/logout', { method: 'POST', headers: { Cookie: 'sac_refresh=refresh-test-only' } }); const cookies = response.headers.get('set-cookie') ?? '';
    expect(response.status).toBe(204); expect(mock.revokeRefreshSession).toHaveBeenCalledWith('refresh-test-only'); expect(cookies).toContain('sac_access='); expect(cookies).toContain('sac_refresh='); expect(cookies).toContain('Max-Age=0');
  });
});
