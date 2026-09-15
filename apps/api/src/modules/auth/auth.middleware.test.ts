import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';

const mock = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock('../../lib/prisma.js', () => ({ prisma: { user: { findUnique: mock.findUnique } } }));
import { requireAuth } from './auth.middleware.js';

describe('validação imediata de sessão', () => {
  beforeEach(() => { vi.clearAllMocks(); process.env.JWT_SECRET = 'test-only-secret'; });
  const run = async (version: number) => { const req = { headers: { authorization: `Bearer ${jwt.sign({ role: 'ANALYST', version }, process.env.JWT_SECRET!, { subject: 'user-1' })}` } } as never; const status = vi.fn().mockReturnThis(); const json = vi.fn(); const next = vi.fn(); await requireAuth(req, { status, json } as never, next); return { req: req as { auth?: unknown }, status, json, next }; };

  it('usa perfil atual do banco e aceita somente a versão vigente', async () => {
    mock.findUnique.mockResolvedValue({ id: 'user-1', role: 'VIEWER', active: true, approvedAt: new Date(), rejectedAt: null, tokenVersion: 3 });
    const result = await run(3); expect(result.next).toHaveBeenCalled(); expect(result.req.auth).toEqual({ userId: 'user-1', role: 'VIEWER' });
  });

  it('rejeita token anterior à troca de senha e usuário inativo', async () => {
    mock.findUnique.mockResolvedValueOnce({ id: 'user-1', role: 'ANALYST', active: true, approvedAt: new Date(), rejectedAt: null, tokenVersion: 4 });
    expect((await run(3)).status).toHaveBeenCalledWith(401);
    mock.findUnique.mockResolvedValueOnce({ id: 'user-1', role: 'ANALYST', active: false, approvedAt: new Date(), rejectedAt: null, tokenVersion: 3 });
    expect((await run(3)).status).toHaveBeenCalledWith(401);
  });
});
