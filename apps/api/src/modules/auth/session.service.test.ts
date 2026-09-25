import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  const database = { authSession: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() }, adminAudit: { create: vi.fn() }, $queryRaw: vi.fn() };
  const transaction = vi.fn(async (callback: (tx: typeof database) => unknown) => callback(database));
  return { database, transaction };
});
vi.mock('../../lib/prisma.js', () => ({ prisma: { ...mock.database, $transaction: mock.transaction } }));
import { createSession, revokeAllSessions, revokeRefreshSession, rotateSession } from './session.service.js';

const user = { id: 'user-1', name: 'Pessoa', email: 'person@example.test', role: 'ANALYST' as const, active: true, approvedAt: new Date(), rejectedAt: null, tokenVersion: 2, timezone: 'America/Sao_Paulo', lastLoginAt: null };
const current = { id: 'session-1', userId: user.id, familyId: 'family-1', tokenVersion: 2, expiresAt: new Date(Date.now() + 86_400_000), revokedAt: null, rotatedAt: null, user };

describe('sessões revogáveis e rotação', () => {
  beforeEach(() => { vi.clearAllMocks(); process.env.JWT_SECRET = 'test-only-secret'; delete process.env.NODE_ENV; mock.database.authSession.create.mockResolvedValue({ id: 'session-next' }); mock.database.authSession.updateMany.mockResolvedValue({ count: 1 }); mock.database.authSession.update.mockResolvedValue({}); mock.database.adminAudit.create.mockResolvedValue({}); mock.database.$queryRaw.mockResolvedValue([]); });

  it('cria sessão armazenando somente hash do refresh token e audita o login', async () => {
    const result = await createSession(user); const data = mock.database.authSession.create.mock.calls[0][0].data;
    expect(data.refreshTokenHash).not.toBe(result.refreshToken); expect(data.refreshTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.accessToken).toBeTruthy(); expect(mock.database.adminAudit.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: 'LOGIN_SUCCEEDED' }) });
  });

  it('rotaciona transacionalmente e invalida o token anterior', async () => {
    mock.database.authSession.findUnique.mockResolvedValue(current);
    const result = await rotateSession('refresh-token-original'); expect(result.ok).toBe(true);
    expect(mock.database.authSession.create).toHaveBeenCalledWith({ data: expect.objectContaining({ familyId: 'family-1', refreshTokenHash: expect.any(String) }), select: { id: true } });
    expect(mock.database.authSession.update).toHaveBeenCalledWith({ where: { id: 'session-1' }, data: expect.objectContaining({ revokedAt: expect.any(Date), rotatedAt: expect.any(Date), replacedById: 'session-next' }) });
  });

  it('detecta reutilização e revoga a família, inclusive em dois refreshes concorrentes', async () => {
    mock.database.authSession.findUnique.mockResolvedValueOnce(current).mockResolvedValueOnce({ ...current, rotatedAt: new Date(), revokedAt: new Date() });
    const results = await Promise.all([rotateSession('same-refresh-token'), rotateSession('same-refresh-token')]);
    expect(results.filter(result => result.ok)).toHaveLength(1); expect(results.filter(result => !result.ok)).toHaveLength(1);
    expect(mock.database.authSession.updateMany).toHaveBeenCalledWith({ where: { familyId: 'family-1', revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(mock.database.adminAudit.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: 'SESSION_REUSE_DETECTED' }) });
  });

  it('bloqueia usuário inativo e tokenVersion incompatível', async () => {
    mock.database.authSession.findUnique.mockResolvedValueOnce({ ...current, user: { ...user, active: false } });
    await expect(rotateSession('inactive-refresh-token')).resolves.toEqual({ ok: false });
    mock.database.authSession.findUnique.mockResolvedValueOnce({ ...current, tokenVersion: 1 });
    await expect(rotateSession('stale-refresh-token')).resolves.toEqual({ ok: false });
    mock.database.authSession.findUnique.mockResolvedValueOnce({ ...current, user: { ...user, deletedAt: new Date() } });
    await expect(rotateSession('deleted-refresh-token')).resolves.toEqual({ ok: false });
    expect(mock.database.authSession.updateMany).toHaveBeenCalledTimes(3);
  });

  it('revoga todas as sessões e registra auditoria sem tokens', async () => {
    await revokeAllSessions('user-1');
    expect(mock.database.authSession.updateMany).toHaveBeenCalledWith({ where: { userId: 'user-1', revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(JSON.stringify(mock.database.adminAudit.create.mock.calls[0][0])).not.toMatch(/refresh|cookie|hash/i);
  });

  it('logout revoga a família inteira e permanece consistente durante rotação', async () => {
    mock.database.authSession.findUnique.mockResolvedValue({ familyId: 'family-1' });
    await revokeRefreshSession('refresh-being-rotated');
    expect(mock.database.$queryRaw).toHaveBeenCalled();
    expect(mock.database.authSession.updateMany).toHaveBeenCalledWith({ where: { familyId: 'family-1', revokedAt: null }, data: { revokedAt: expect.any(Date) } });
  });
});
