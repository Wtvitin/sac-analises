import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';

const mock = vi.hoisted(() => ({ currentSession: vi.fn() }));
vi.mock('./session.service.js', () => ({ currentSession: mock.currentSession }));
import { requireAuth } from './auth.middleware.js';

describe('validação imediata de sessão', () => {
  beforeEach(() => { vi.clearAllMocks(); process.env.JWT_SECRET = 'test-only-secret'; });
  const run = async (version: number) => {
    const token = jwt.sign({ version, sessionId: 'session-1' }, process.env.JWT_SECRET!, { subject: 'user-1' });
    const req = { headers: { cookie: `sac_access=${token}` } } as never; const status = vi.fn().mockReturnThis(); const json = vi.fn(); const next = vi.fn();
    await requireAuth(req, { status, json } as never, next); return { req: req as { auth?: unknown }, status, json, next };
  };

  it('usa perfil atual do banco e exige sessão revogável vigente', async () => {
    mock.currentSession.mockResolvedValue({ id: 'session-1', tokenVersion: 3, user: { id: 'user-1', role: 'VIEWER', active: true, approvedAt: new Date(), rejectedAt: null, tokenVersion: 3 } });
    const result = await run(3); expect(result.next).toHaveBeenCalled(); expect(result.req.auth).toEqual({ userId: 'user-1', role: 'VIEWER', sessionId: 'session-1' });
  });

  it('rejeita token anterior, sessão revogada e usuário inativo', async () => {
    mock.currentSession.mockResolvedValueOnce({ id: 'session-1', tokenVersion: 3, user: { id: 'user-1', role: 'ANALYST', active: true, approvedAt: new Date(), rejectedAt: null, tokenVersion: 4 } });
    expect((await run(3)).status).toHaveBeenCalledWith(401);
    mock.currentSession.mockResolvedValueOnce(null); expect((await run(3)).status).toHaveBeenCalledWith(401);
    mock.currentSession.mockResolvedValueOnce({ id: 'session-1', tokenVersion: 3, user: { id: 'user-1', role: 'ANALYST', active: false, approvedAt: new Date(), rejectedAt: null, tokenVersion: 3 } });
    expect((await run(3)).status).toHaveBeenCalledWith(401);
  });
});
