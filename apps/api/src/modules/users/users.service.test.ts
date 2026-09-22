import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  const database = {
    user: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    sacRecord: { findMany: vi.fn(), update: vi.fn(), count: vi.fn() }, activityLog: { create: vi.fn() }, notification: { create: vi.fn() }, adminAudit: { create: vi.fn(), findMany: vi.fn() }, authSession: { updateMany: vi.fn() }, $executeRaw: vi.fn(),
  };
  const transaction = vi.fn(async (input: unknown, _options?: unknown) => typeof input === 'function' ? (input as (tx: typeof database) => unknown)(database) : Promise.all(input as Promise<unknown>[]));
  return { database, transaction };
});
vi.mock('../../lib/prisma.js', () => ({ prisma: { ...mock.database, $transaction: mock.transaction } }));
import { approveUser, changeUserRole, deactivateUser, listUsers, reactivateUser, rejectUser } from './users.service.js';

const now = new Date('2026-09-14T15:00:00Z');
const publicUser = { id: 'user-1', name: 'Pessoa', email: 'person@example.test', role: 'ANALYST', active: true, approvedAt: now, rejectedAt: null, lastLoginAt: null, createdAt: now };

describe('gestão transacional da equipe', () => {
  beforeEach(() => { vi.clearAllMocks(); mock.database.user.update.mockResolvedValue(publicUser); mock.database.user.updateMany.mockResolvedValue({ count: 1 }); mock.database.user.findUniqueOrThrow.mockResolvedValue(publicUser); mock.database.adminAudit.create.mockResolvedValue({ id: 'audit-1' }); mock.database.authSession.updateMany.mockResolvedValue({ count: 1 }); mock.database.activityLog.create.mockResolvedValue({ id: 'activity-1' }); mock.database.notification.create.mockResolvedValue({ id: 'notification-1' }); mock.database.$executeRaw.mockResolvedValue(1); });

  it('aprova somente como analista ou consulta e registra auditoria', async () => {
    mock.database.user.findUnique.mockResolvedValue({ ...publicUser, active: false, approvedAt: null, approvedById: null });
    await approveUser('user-1', 'ANALYST', 'admin-1');
    expect(mock.database.user.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ role: 'ANALYST', active: true, approvedById: 'admin-1', tokenVersion: { increment: 1 } }) }));
    expect(mock.database.adminAudit.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: 'ACCESS_APPROVED', actorId: 'admin-1' }) });
  });

  it('pagina com seleção explícita sem hash ou versão de token', async () => {
    mock.database.user.findMany.mockResolvedValue([{ ...publicUser, _count: { assignedCases: 2 } }]); mock.database.user.count.mockResolvedValue(1);
    const result = await listUsers({ query: '', role: 'all', state: 'all', approval: 'all', sort: 'name', order: 'asc', page: 1, pageSize: 20 });
    expect(result.items[0]).toMatchObject({ openAssignedCases: 2 });
    const select = mock.database.user.findMany.mock.calls[0][0].select; expect(select.passwordHash).toBeUndefined(); expect(select.tokenVersion).toBeUndefined();
  });

  it('recusa sem excluir e mantém justificativa auditável', async () => {
    mock.database.user.findUnique.mockResolvedValue({ ...publicUser, role: 'VIEWER', active: false, approvedAt: null });
    await rejectUser('user-1', 'Vínculo corporativo não confirmado.', 'admin-1');
    expect(mock.database.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ active: false, approvedAt: null, rejectedAt: expect.any(Date), tokenVersion: { increment: 1 } }) }));
    expect(mock.database.adminAudit.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: 'ACCESS_REJECTED', justification: 'Vínculo corporativo não confirmado.' }) });
  });

  it('protege o último administrador sob lock transacional e audita o bloqueio', async () => {
    mock.database.user.findUnique.mockResolvedValue({ ...publicUser, role: 'ADMIN' }); mock.database.user.count.mockResolvedValue(0);
    await expect(changeUserRole('user-1', { role: 'ANALYST', justification: 'Reorganização administrativa.' }, 'admin-1')).rejects.toMatchObject({ code: 'LAST_ADMIN_PROTECTED' });
    expect(mock.database.$executeRaw).toHaveBeenCalled(); expect(mock.database.user.update).not.toHaveBeenCalled();
    expect(mock.database.adminAudit.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: 'LAST_ADMIN_BLOCKED' }) });
    expect(mock.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
  });

  it('transfere somente casos abertos, registra histórico e notifica o novo responsável', async () => {
    mock.database.user.findUnique.mockResolvedValue({ ...publicUser, role: 'ANALYST' }); mock.database.sacRecord.findMany.mockResolvedValue([{ id: 'case-1', ticket: 'SAC-1' }]); mock.database.user.findFirst.mockResolvedValue({ id: 'analyst-2', name: 'Responsável' });
    await deactivateUser('user-1', { justification: 'Mudança de área.', strategy: 'transfer', transferToUserId: 'analyst-2' }, 'admin-1');
    expect(mock.database.sacRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: { in: ['PENDING', 'IN_PROGRESS'] } }) }));
    expect(mock.database.sacRecord.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ assigneeId: 'analyst-2', lastOperationalActivityAt: expect.any(Date) }) }));
    expect(mock.database.activityLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ eventType: 'CASE_TRANSFERRED' }) });
    expect(mock.database.notification.create).toHaveBeenCalledWith({ data: expect.objectContaining({ recipientId: 'analyst-2', type: 'ASSIGNEE_CHANGED' }) });
    expect(mock.database.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { active: false, tokenVersion: { increment: 1 } } }));
  });

  it('reativa conta aprovada sem devolver casos anteriores', async () => {
    mock.database.user.findUnique.mockResolvedValue({ active: false, approvedAt: now, rejectedAt: null });
    await reactivateUser('user-1', 'Retorno à operação.', 'admin-1');
    expect(mock.database.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { active: true, tokenVersion: { increment: 1 } } }));
    expect(mock.database.sacRecord.update).not.toHaveBeenCalled();
  });
});
