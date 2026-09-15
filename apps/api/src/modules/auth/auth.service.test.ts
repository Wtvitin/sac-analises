import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  const database = {
    user: { findUnique: vi.fn(), create: vi.fn(), findMany: vi.fn(), update: vi.fn(), findUniqueOrThrow: vi.fn() },
    adminAudit: { create: vi.fn() }, notification: { createMany: vi.fn() },
  };
  const transaction = vi.fn(async (input: unknown) => typeof input === 'function' ? (input as (tx: typeof database) => unknown)(database) : Promise.all(input as Promise<unknown>[]));
  const bcrypt = { hash: vi.fn(), compare: vi.fn() };
  return { database, transaction, bcrypt };
});
vi.mock('../../lib/prisma.js', () => ({ prisma: { ...mock.database, $transaction: mock.transaction } }));
vi.mock('bcryptjs', () => ({ default: mock.bcrypt }));

import { authenticate, changeOwnPassword, requestAccess } from './auth.service.js';

const approved = { id: 'user-1', name: 'Pessoa', email: 'pessoa@example.test', passwordHash: 'hash', role: 'ANALYST', active: true, approvedAt: new Date(), rejectedAt: null, tokenVersion: 2, timezone: 'America/Sao_Paulo', lastLoginAt: null };

describe('ciclo de autenticação e acesso', () => {
  beforeEach(() => { vi.clearAllMocks(); mock.bcrypt.hash.mockResolvedValue('safe-hash'); mock.bcrypt.compare.mockResolvedValue(true); mock.database.adminAudit.create.mockResolvedValue({ id: 'audit-1' }); mock.database.notification.createMany.mockResolvedValue({ count: 1 }); });

  it('cria solicitação não aprovada, audita e notifica administradores sem dados sensíveis', async () => {
    mock.database.user.findUnique.mockResolvedValue(null); mock.database.user.create.mockResolvedValue({ id: 'request-1' }); mock.database.user.findMany.mockResolvedValue([{ id: 'admin-1' }]);
    await expect(requestAccess({ name: '<b>Pessoa Solicitante</b>', email: 'PESSOA@EXAMPLE.TEST', password: 'SenhaSegura123', confirmPassword: 'SenhaSegura123' })).resolves.toEqual({ accepted: true, created: true });
    expect(mock.database.user.create).toHaveBeenCalledWith({ data: expect.objectContaining({ name: 'Pessoa Solicitante', email: 'pessoa@example.test', role: 'VIEWER', active: false, passwordHash: 'safe-hash' }), select: { id: true } });
    expect(mock.database.adminAudit.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: 'ACCESS_REQUESTED', targetUserId: 'request-1' }) });
    const notificationData = mock.database.notification.createMany.mock.calls[0][0].data[0];
    expect(notificationData).toMatchObject({ recipientId: 'admin-1', type: 'ACCESS_REQUEST', dedupeKey: 'access-request:request-1' });
    expect(JSON.stringify(notificationData)).not.toMatch(/SenhaSegura|safe-hash/i);
  });

  it('responde de forma idêntica para e-mail existente sem criar outra conta', async () => {
    mock.database.user.findUnique.mockResolvedValue({ id: 'existing' });
    await expect(requestAccess({ name: 'Pessoa Solicitante', email: 'pessoa@example.test', password: 'SenhaSegura123', confirmPassword: 'SenhaSegura123' })).resolves.toEqual({ accepted: true, created: false });
    expect(mock.database.user.create).not.toHaveBeenCalled(); expect(mock.database.notification.createMany).not.toHaveBeenCalled();
  });

  it('bloqueia login não aprovado e registra último acesso somente no sucesso', async () => {
    mock.database.user.findUnique.mockResolvedValueOnce({ ...approved, active: false, approvedAt: null });
    await expect(authenticate({ email: approved.email, password: 'SenhaSegura123' })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(mock.database.user.update).not.toHaveBeenCalled();
    mock.database.user.findUnique.mockResolvedValueOnce(approved); mock.database.user.update.mockResolvedValue(approved);
    await expect(authenticate({ email: approved.email, password: 'SenhaSegura123' })).resolves.toMatchObject({ publicUser: { email: approved.email } });
    expect(mock.database.user.update).toHaveBeenCalledWith({ where: { id: 'user-1' }, data: { lastLoginAt: expect.any(Date) } });
  });

  it('altera a própria senha, incrementa a versão e audita sem conteúdo sensível', async () => {
    mock.database.user.findUniqueOrThrow.mockResolvedValue({ passwordHash: 'old-hash' }); mock.bcrypt.compare.mockResolvedValueOnce(true).mockResolvedValueOnce(false); mock.database.user.update.mockResolvedValue({ id: 'user-1' });
    await changeOwnPassword('user-1', { currentPassword: 'SenhaAnterior123', newPassword: 'SenhaNovaSegura123', confirmPassword: 'SenhaNovaSegura123' });
    expect(mock.database.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { passwordHash: 'safe-hash', tokenVersion: { increment: 1 } } }));
    const audit = mock.database.adminAudit.create.mock.calls[0][0]; expect(audit.data).toMatchObject({ type: 'PASSWORD_CHANGED', actorId: 'user-1', targetUserId: 'user-1' });
    expect(JSON.stringify(audit)).not.toMatch(/Senha|hash/i);
  });
});
