import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  const database = {
    sacRecord: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
    },
    reason: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    activityLog: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    adminAudit: {
      create: vi.fn(),
    },
    comment: {
      create: vi.fn(),
    },
    notification: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  return {
    database,
    transaction: vi.fn(async (input: unknown) =>
      typeof input === 'function' ? (input as (tx: typeof database) => unknown)(database) : Promise.all(input as Promise<unknown>[])
    ),
  };
});

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    ...mock.database,
    $transaction: mock.transaction,
  },
}));

import {
  deleteSacRecord,
  getSacRecord,
  getSacHistory,
  updateSacTreatment,
  changeSacStatus,
  addSacComment,
  listSacRecords,
} from './sac.service.js';
import {
  listNotifications,
  unreadNotificationCount,
} from '../notifications/notification.service.js';

const initialUpdatedAt = new Date('2026-10-05T10:00:00.000Z');

const fakeRecord = {
  id: 'sac-101',
  ticket: 'SAC-2026-0101',
  department: 'SAC',
  status: 'IN_PROGRESS' as const,
  priority: 'MEDIUM' as const,
  assigneeId: 'analyst-1',
  openedAt: new Date('2026-10-01T08:00:00.000Z'),
  dueAt: new Date('2026-10-08T18:00:00.000Z'),
  updatedAt: initialUpdatedAt,
  archivedAt: null,
  deletedAt: null,
  deletedById: null,
  deletedBy: null,
  deletionReason: null,
  solutionSummary: 'Tratativa preliminar',
  identifiedCause: null,
  responsibleArea: null,
  correctiveAction: null,
  reopenedReason: null,
  cancellationReason: null,
  completedAt: null,
  customer: { id: 'cust-1', name: 'Consumidor Exemplo', document: '12345678900' },
  items: [{ id: 'item-1', sacId: 'sac-101', productName: 'Item A', quantity: 1 }],
  attachments: [{ id: 'att-1', sacId: 'sac-101', originalFilename: 'doc.pdf', storagePath: 'uploads/doc.pdf' }],
};

describe('Exclusão Lógica e Auditoria de Registros SAC (sac.service.ts)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.database.sacRecord.findFirst.mockResolvedValue(fakeRecord);
    mock.database.sacRecord.updateMany.mockResolvedValue({ count: 1 });
    mock.database.sacRecord.findUniqueOrThrow.mockResolvedValue({
      ...fakeRecord,
      archivedAt: new Date('2026-10-05T14:30:00.000Z'),
      deletedAt: new Date('2026-10-05T14:30:00.000Z'),
      deletedById: 'admin-1',
      deletedBy: 'Administrador Master',
      deletionReason: 'Caso inserido para testes operacionais',
    });
    mock.database.user.findUnique.mockResolvedValue({
      id: 'admin-1',
      name: 'Administrador Master',
      role: 'ADMIN',
      email: 'admin@sac.local',
      active: true,
    });
    mock.database.user.findUniqueOrThrow.mockResolvedValue({
      id: 'admin-1',
      name: 'Administrador Master',
      role: 'ADMIN',
      email: 'admin@sac.local',
      active: true,
    });
    mock.database.activityLog.create.mockResolvedValue({ id: 'log-1' });
    mock.database.adminAudit.create.mockResolvedValue({ id: 'audit-1' });
  });

  it('bloqueia exclusão direta por perfis não-ADMIN com 403 FORBIDDEN', async () => {
    await expect(
      deleteSacRecord(
        'sac-101',
        { updatedAt: initialUpdatedAt, justification: 'Tentativa de exclusão indevida' },
        'analyst-1',
        'ANALYST',
        'SAC'
      )
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });

    await expect(
      deleteSacRecord(
        'sac-101',
        { updatedAt: initialUpdatedAt, justification: 'Tentativa de exclusão indevida' },
        'viewer-1',
        'VIEWER',
        null
      )
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });

    expect(mock.database.sacRecord.updateMany).not.toHaveBeenCalled();
    expect(mock.database.activityLog.create).not.toHaveBeenCalled();
    expect(mock.database.adminAudit.create).not.toHaveBeenCalled();
  });

  it('impede exclusão se o registro já estiver arquivado ou excluído (404)', async () => {
    mock.database.sacRecord.findFirst.mockResolvedValueOnce(null);

    await expect(
      deleteSacRecord(
        'sac-101',
        { updatedAt: initialUpdatedAt, justification: 'Caso não existente ou já excluído' },
        'admin-1',
        'ADMIN'
      )
    ).rejects.toMatchObject({
      code: 'SAC_RECORD_NOT_FOUND',
      status: 404,
    });

    expect(mock.database.sacRecord.updateMany).not.toHaveBeenCalled();
  });

  it('detecta concorrência e rejeita com 409 CONFLICT se o registro foi alterado após a abertura do modal', async () => {
    const staleDate = new Date('2026-10-05T09:00:00.000Z'); // anterior a initialUpdatedAt

    await expect(
      deleteSacRecord(
        'sac-101',
        { updatedAt: staleDate, justification: 'Tentativa com data defasada' },
        'admin-1',
        'ADMIN'
      )
    ).rejects.toMatchObject({
      code: 'STALE_SAC_RECORD',
      status: 409,
    });

    expect(mock.database.sacRecord.updateMany).not.toHaveBeenCalled();
  });

  it('realiza exclusão lógica com sucesso por ADMIN, preenche metadados e gera trilha de auditoria dupla', async () => {
    const result = await deleteSacRecord(
      'sac-101',
      {
        updatedAt: initialUpdatedAt,
        justification: 'Registro duplicado inserido por engano pelo operador',
      },
      'admin-1',
      'ADMIN'
    );

    expect(result).toBeDefined();
    expect(result.id).toBe('sac-101');
    expect(result.ticket).toBe('SAC-2026-0101');

    // Verifica soft-delete no banco com data de arquivo e exclusão lógica
    expect(mock.database.sacRecord.updateMany).toHaveBeenCalledTimes(1);
    const updateCall = mock.database.sacRecord.updateMany.mock.calls[0][0];
    expect(updateCall.where.id).toBe('sac-101');
    expect(updateCall.where.archivedAt).toBeNull();
    expect(updateCall.data.deletedById).toBe('admin-1');
    expect(updateCall.data.deletionReason).toBe('Registro duplicado inserido por engano pelo operador');
    expect(updateCall.data.deletedAt).toBeInstanceOf(Date);
    expect(updateCall.data.archivedAt).toBeInstanceOf(Date);

    // Trilha 1: ActivityLog com SAC_DELETED
    expect(mock.database.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        recordId: 'sac-101',
        actorId: 'admin-1',
        eventType: 'SAC_DELETED',
        after: expect.objectContaining({
          justification: 'Registro duplicado inserido por engano pelo operador',
        }),
      }),
    });

    // Trilha 2: AdminAudit com CASE_DELETED
    expect(mock.database.adminAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'admin-1',
        type: 'CASE_DELETED',
        justification: 'Registro duplicado inserido por engano pelo operador',
        metadata: expect.objectContaining({
          recordId: 'sac-101',
          ticket: 'SAC-2026-0101',
        }),
      }),
    });
  });

  it('bloqueia operações operacionais posteriores no registro excluído', async () => {
    // Simulando que o registro está marcado como arquivado/excluído (findFirst com archivedAt: null retorna null)
    mock.database.sacRecord.findFirst.mockResolvedValue(null);

    // Consulta operacional (GET)
    await expect(getSacRecord('sac-101', 'ADMIN')).rejects.toMatchObject({
      code: 'SAC_RECORD_NOT_FOUND',
      status: 404,
    });

    // Gravação de tratativa (PATCH)
    await expect(
      updateSacTreatment(
        'sac-101',
        { updatedAt: initialUpdatedAt, solutionSummary: 'Tentativa de alteração' },
        'admin-1',
        'ADMIN'
      )
    ).rejects.toMatchObject({
      code: 'SAC_RECORD_NOT_FOUND',
      status: 404,
    });

    // Transição de status (POST /status)
    await expect(
      changeSacStatus(
        'sac-101',
        { updatedAt: initialUpdatedAt, status: 'IN_PROGRESS', assumeIfUnassigned: false },
        'admin-1',
        'ADMIN'
      )
    ).rejects.toMatchObject({
      code: 'SAC_RECORD_NOT_FOUND',
      status: 404,
    });

    // Adição de comentário (POST /comments)
    await expect(
      addSacComment(
        'sac-101',
        { updatedAt: initialUpdatedAt, body: 'Comentário em caso deletado' },
        'admin-1',
        'ADMIN'
      )
    ).rejects.toMatchObject({
      code: 'SAC_RECORD_NOT_FOUND',
      status: 404,
    });
  });

  it('permite acesso ao histórico administrativo do caso excluído exclusivamente para ADMIN', async () => {
    const deletedRecordState = {
      ...fakeRecord,
      archivedAt: new Date('2026-10-05T14:30:00.000Z'),
      deletedAt: new Date('2026-10-05T14:30:00.000Z'),
      deletedById: 'admin-1',
      deletedBy: 'Administrador Master',
      deletionReason: 'Exclusão administrativa',
    };

    mock.database.sacRecord.findFirst.mockImplementation(async ({ where }: any) => {
      if (where?.archivedAt === null) return null;
      return deletedRecordState;
    });
    mock.database.activityLog.findMany.mockResolvedValue([
      {
        id: 'log-delete',
        recordId: 'sac-101',
        eventType: 'SAC_DELETED',
        createdAt: new Date('2026-10-05T14:30:00.000Z'),
        details: { ticket: 'SAC-2026-0101', justification: 'Exclusão administrativa' },
        actor: { id: 'admin-1', name: 'Administrador Master' },
      },
    ]);
    mock.database.activityLog.count.mockResolvedValue(1);

    // ADMIN consegue consultar o histórico
    const adminHistory = await getSacHistory('sac-101', { page: 1, pageSize: 20 }, 'ADMIN');
    expect(adminHistory).toBeDefined();
    expect(adminHistory.total).toBe(1);
    expect(adminHistory.items[0].eventType).toBe('SAC_DELETED');

    // ANALYST recebe 404 ao tentar acessar histórico de caso excluído
    await expect(
      getSacHistory('sac-101', { page: 1, pageSize: 20 }, 'ANALYST')
    ).rejects.toMatchObject({
      code: 'SAC_RECORD_NOT_FOUND',
      status: 404,
    });

    // VIEWER recebe 404 ao tentar acessar histórico de caso excluído
    await expect(
      getSacHistory('sac-101', { page: 1, pageSize: 20 }, 'VIEWER')
    ).rejects.toMatchObject({
      code: 'SAC_RECORD_NOT_FOUND',
      status: 404,
    });
  });

  it('comprova que o caso excluído (com archivedAt preenchido) é excluído das listagens operacionais', async () => {
    mock.database.sacRecord.findMany.mockResolvedValue([]);
    mock.database.sacRecord.count.mockResolvedValue(0);
    mock.database.user.findMany.mockResolvedValue([]);
    mock.database.sacRecord.groupBy.mockResolvedValue([]);

    await listSacRecords({ page: 1, pageSize: 20 }, 'ADMIN');

    expect(mock.database.sacRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          archivedAt: null,
        }),
      })
    );
    expect(mock.database.sacRecord.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          archivedAt: null,
        }),
      })
    );
  });

  it('comprova que notificações de casos excluídos desaparecem da listagem e da contagem de não lidas', async () => {
    mock.database.notification.findMany.mockResolvedValue([]);
    mock.database.notification.count.mockResolvedValue(0);

    await listNotifications('admin-1', { page: 1, pageSize: 20, filter: 'all' }, 'ADMIN');

    expect(mock.database.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          recipientId: 'admin-1',
          OR: [
            { recordId: null },
            { record: { archivedAt: null } },
          ],
        }),
      })
    );

    await unreadNotificationCount('admin-1', 'ADMIN');

    expect(mock.database.notification.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          recipientId: 'admin-1',
          readAt: null,
          OR: [
            { recordId: null },
            { record: { archivedAt: null } },
          ],
        }),
      })
    );
  });
});

