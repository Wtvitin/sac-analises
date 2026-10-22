import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  const database = {
    notification: { create: vi.fn(), findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn(), createMany: vi.fn() },
    user: { findMany: vi.fn() },
    sacRecord: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  };
  const transaction = vi.fn(async (input: unknown) => typeof input === 'function'
    ? (input as (tx: typeof database) => unknown)(database)
    : Promise.all(input as Promise<unknown>[]));
  return { database, transaction };
});

vi.mock('../../lib/prisma.js', () => ({ prisma: { ...mock.database, $transaction: mock.transaction } }));

import {
  createCaseNotification, generateTemporalNotifications, getNotification, listNotifications,
  markAllNotificationsRead, markNotificationRead, unreadNotificationCount,
} from './notification.service.js';

const notification = {
  id: 'notification-1', recipientId: 'analyst-1', recordId: 'sac-1', type: 'COMMENT_ADDED',
  title: 'Novo comentário', summary: 'O caso recebeu um comentário.', metadata: null,
  dedupeKey: null, readAt: null, createdAt: new Date('2026-09-14T12:00:00Z'), record: null,
};

describe('serviço de notificações persistentes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.database.notification.create.mockResolvedValue(notification);
    mock.database.notification.findMany.mockResolvedValue([notification]);
    mock.database.notification.count.mockResolvedValue(1);
    mock.database.notification.findFirst.mockResolvedValue(notification);
    mock.database.notification.updateMany.mockResolvedValue({ count: 1 });
  });

  it('cria a notificação na transação e evita auto-notificação', async () => {
    await createCaseNotification(mock.database as never, {
      recipientId: 'analyst-1', actorId: 'admin-1', recordId: 'sac-1', ticket: 'SAC-1',
      type: 'ASSIGNED', title: 'Caso atribuído', summary: 'Um caso foi atribuído.',
    });
    expect(mock.database.notification.create).toHaveBeenCalledWith({ data: expect.objectContaining({ recipientId: 'analyst-1', type: 'ASSIGNED' }) });
    await createCaseNotification(mock.database as never, {
      recipientId: 'admin-1', actorId: 'admin-1', recordId: 'sac-1', ticket: 'SAC-1',
      type: 'ASSIGNED', title: 'Caso atribuído', summary: 'Um caso foi atribuído.',
    });
    expect(mock.database.notification.create).toHaveBeenCalledTimes(1);
  });

  it('lista e conta somente notificações do destinatário autenticado', async () => {
    const result = await listNotifications('analyst-1', { filter: 'unread', page: 2, pageSize: 20 });
    expect(mock.database.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ recipientId: 'analyst-1', readAt: null }), skip: 20, take: 20,
    }));
    expect(result).toMatchObject({ total: 1, page: 2, pageSize: 20 });
    await unreadNotificationCount('analyst-1');
    expect(mock.database.notification.count).toHaveBeenLastCalledWith({
      where: expect.objectContaining({ recipientId: 'analyst-1', readAt: null }),
    });
  });

  it('isola consulta e leitura por destinatário e retorna 404 fora do escopo', async () => {
    mock.database.notification.findFirst.mockResolvedValueOnce(null);
    await expect(getNotification('other-user', 'notification-1')).rejects.toMatchObject({ code: 'NOTIFICATION_NOT_FOUND', status: 404 });
    expect(mock.database.notification.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'notification-1', recipientId: 'other-user' }),
    }));

    mock.database.notification.updateMany.mockResolvedValueOnce({ count: 0 });
    mock.database.notification.findFirst.mockResolvedValueOnce(null);
    await expect(markNotificationRead('other-user', 'notification-1')).rejects.toMatchObject({ code: 'NOTIFICATION_NOT_FOUND', status: 404 });
    expect(mock.database.notification.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'notification-1', recipientId: 'other-user', readAt: null }),
    }));
  });

  it('marca uma ou todas como lidas apenas no escopo do usuário', async () => {
    await markNotificationRead('analyst-1', 'notification-1', new Date('2026-09-14T13:00:00Z'));
    expect(mock.database.notification.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'notification-1', recipientId: 'analyst-1', readAt: null }),
    }));
    await markAllNotificationsRead('analyst-1', new Date('2026-09-14T13:00:00Z'));
    expect(mock.database.notification.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ recipientId: 'analyst-1', readAt: null }),
    }));
  });

  it('gera condições temporais idempotentes com chaves distintas', async () => {
    const now = new Date('2026-09-14T15:00:00Z');
    const base = { status: 'PENDING', priority: 'MEDIUM', openedAt: new Date('2026-09-01T12:00:00Z'), lastOperationalActivityAt: now };
    mock.database.$queryRaw.mockResolvedValue([{ acquired: true }]);
    mock.database.user.findMany.mockResolvedValue([{ id: 'admin-1' }]);
    mock.database.sacRecord.findMany.mockResolvedValue([
      { ...base, id: 'near', ticket: 'SAC-NEAR', assigneeId: 'analyst-1', dueAt: new Date('2026-09-15T15:00:00Z') },
      { ...base, id: 'today', ticket: 'SAC-TODAY', assigneeId: 'analyst-1', dueAt: new Date('2026-09-14T15:00:00Z') },
      { ...base, id: 'late', ticket: 'SAC-LATE', assigneeId: 'analyst-1', dueAt: new Date('2026-09-13T15:00:00Z') },
      { ...base, id: 'stale', ticket: 'SAC-STALE', assigneeId: 'analyst-1', dueAt: new Date('2026-10-01T15:00:00Z'), lastOperationalActivityAt: new Date('2026-09-10T14:59:59Z') },
      { ...base, id: 'free', ticket: 'SAC-FREE', assigneeId: null, dueAt: new Date('2026-10-01T15:00:00Z') },
    ]);
    mock.database.notification.createMany.mockResolvedValueOnce({ count: 5 }).mockResolvedValueOnce({ count: 0 });

    await expect(generateTemporalNotifications(now)).resolves.toEqual({ acquired: true, created: 5 });
    const data = mock.database.notification.createMany.mock.calls[0][0].data as Array<{ type: string; dedupeKey: string }>;
    expect(data.map(item => item.type)).toEqual(['NEAR_DUE', 'DUE_TODAY', 'OVERDUE', 'STALE', 'UNASSIGNED']);
    expect(new Set(data.map(item => item.dedupeKey)).size).toBe(5);
    expect(mock.database.notification.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
    await expect(generateTemporalNotifications(now)).resolves.toEqual({ acquired: true, created: 0 });
  });

  it('não processa um segundo gerador quando o lock PostgreSQL está ocupado', async () => {
    mock.database.$queryRaw.mockResolvedValue([{ acquired: false }]);
    await expect(generateTemporalNotifications()).resolves.toEqual({ acquired: false, created: 0 });
    expect(mock.database.sacRecord.findMany).not.toHaveBeenCalled();
    expect(mock.database.notification.createMany).not.toHaveBeenCalled();
  });
});
