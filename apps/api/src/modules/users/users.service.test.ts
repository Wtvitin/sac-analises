import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  const database = {
    user: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    sacRecord: {
      findMany: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    activityLog: { create: vi.fn() },
    notification: { create: vi.fn(), deleteMany: vi.fn() },
    adminAudit: { create: vi.fn(), findMany: vi.fn() },
    authSession: { updateMany: vi.fn(), deleteMany: vi.fn() },
    $executeRaw: vi.fn(),
  };
  const transaction = vi.fn(async (input: unknown, _options?: unknown) =>
    typeof input === 'function' ? (input as (tx: typeof database) => unknown)(database) : Promise.all(input as Promise<unknown>[])
  );
  return { database, transaction };
});

vi.mock('../../lib/prisma.js', () => ({
  prisma: { ...mock.database, $transaction: mock.transaction },
}));

import {
  approveUser,
  changeUserRole,
  createUser,
  deactivateUser,
  deleteUser,
  listUsers,
  reactivateUser,
  rejectUser,
  resendProvisionalPassword,
} from './users.service.js';
import * as emailService from '../../lib/email/email.service.js';

const now = new Date('2026-09-14T15:00:00Z');
const publicUser = {
  id: 'user-1',
  name: 'Pessoa',
  email: 'person@example.test',
  role: 'ANALYST',
  active: true,
  approvedAt: now,
  rejectedAt: null,
  lastLoginAt: null,
  createdAt: now,
};

describe('gestão transacional da equipe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.database.user.create.mockResolvedValue(publicUser);
    mock.database.user.update.mockResolvedValue(publicUser);
    mock.database.user.updateMany.mockResolvedValue({ count: 1 });
    mock.database.user.findUniqueOrThrow.mockResolvedValue(publicUser);
    mock.database.adminAudit.create.mockResolvedValue({ id: 'audit-1' });
    mock.database.authSession.updateMany.mockResolvedValue({ count: 1 });
    mock.database.activityLog.create.mockResolvedValue({ id: 'activity-1' });
    mock.database.notification.create.mockResolvedValue({ id: 'notification-1' });
    mock.database.$executeRaw.mockResolvedValue(1);
  });

  describe('Aprovação e listagem', () => {
    it('aprova somente como analista ou consulta e registra auditoria', async () => {
      mock.database.user.findUnique.mockResolvedValue({ ...publicUser, active: false, approvedAt: null, approvedById: null });
      await approveUser('user-1', 'ANALYST', 'admin-1');
      expect(mock.database.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ role: 'ANALYST', active: true, approvedById: 'admin-1', tokenVersion: { increment: 1 } }) })
      );
      expect(mock.database.adminAudit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ type: 'ACCESS_APPROVED', actorId: 'admin-1' }),
      });
    });

    it('pagina com seleção explícita sem hash ou versão de token', async () => {
      mock.database.user.findMany.mockResolvedValue([{ ...publicUser, _count: { assignedCases: 2 } }]);
      mock.database.user.count.mockResolvedValue(1);
      const result = await listUsers({ query: '', role: 'all', state: 'all', approval: 'all', sort: 'name', order: 'asc', page: 1, pageSize: 20 });
      expect(result.items[0]).toMatchObject({ openAssignedCases: 2 });
      const select = mock.database.user.findMany.mock.calls[0][0].select;
      expect(select.passwordHash).toBeUndefined();
      expect(select.tokenVersion).toBeUndefined();
    });

    it('recusa sem excluir e mantém justificativa auditável', async () => {
      mock.database.user.findUnique.mockResolvedValue({ ...publicUser, role: 'VIEWER', active: false, approvedAt: null });
      await rejectUser('user-1', 'Vínculo corporativo não confirmado.', 'admin-1');
      expect(mock.database.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ active: false, approvedAt: null, rejectedAt: expect.any(Date), tokenVersion: { increment: 1 } }) })
      );
      expect(mock.database.adminAudit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ type: 'ACCESS_REJECTED', justification: 'Vínculo corporativo não confirmado.' }),
      });
    });
  });

  describe('Proteção de administradores (própria conta e entre administradores)', () => {
    it('impede qualquer ação administrativa na própria conta (SELF_ACTION_BLOCKED)', async () => {
      mock.database.user.findUnique.mockResolvedValue({ ...publicUser, id: 'admin-1', role: 'ADMIN' });
      await expect(
        changeUserRole('admin-1', { role: 'ANALYST', justification: 'Auto-rebaixamento.' }, 'admin-1')
      ).rejects.toMatchObject({ code: 'SELF_ACTION_BLOCKED', status: 403 });

      await expect(
        deactivateUser('admin-1', { justification: 'Auto-inativação.' }, 'admin-1')
      ).rejects.toMatchObject({ code: 'SELF_ACTION_BLOCKED', status: 403 });

      await expect(
        deleteUser('admin-1', { justification: 'Auto-exclusão.' }, 'admin-1')
      ).rejects.toMatchObject({ code: 'SELF_ACTION_BLOCKED', status: 403 });

      await expect(
        rejectUser('admin-1', 'Auto-recusa.', 'admin-1')
      ).rejects.toMatchObject({ code: 'SELF_ACTION_BLOCKED', status: 403 });

      await expect(
        reactivateUser('admin-1', 'Auto-reativação.', 'admin-1')
      ).rejects.toMatchObject({ code: 'SELF_ACTION_BLOCKED', status: 403 });

      await expect(
        approveUser('admin-1', 'ANALYST', 'admin-1')
      ).rejects.toMatchObject({ code: 'SELF_ACTION_BLOCKED', status: 403 });

      await expect(
        resendProvisionalPassword('admin-1', 'admin-1')
      ).rejects.toMatchObject({ code: 'SELF_ACTION_BLOCKED', status: 403 });
    });

    it('impede que um administrador altere ou inative outro administrador (ADMIN_PROTECTION)', async () => {
      mock.database.user.findUnique.mockResolvedValue({ ...publicUser, id: 'admin-2', role: 'ADMIN' });

      await expect(
        changeUserRole('admin-2', { role: 'ANALYST', justification: 'Tentativa de alterar outro admin.' }, 'admin-1')
      ).rejects.toMatchObject({ code: 'ADMIN_PROTECTION', status: 403 });

      await expect(
        deactivateUser('admin-2', { justification: 'Tentativa de inativar outro admin.' }, 'admin-1')
      ).rejects.toMatchObject({ code: 'ADMIN_PROTECTION', status: 403 });

      await expect(
        deleteUser('admin-2', { justification: 'Tentativa de excluir outro admin.' }, 'admin-1')
      ).rejects.toMatchObject({ code: 'ADMIN_PROTECTION', status: 403 });

      await expect(
        rejectUser('admin-2', 'Tentativa de recusar outro admin.', 'admin-1')
      ).rejects.toMatchObject({ code: 'ADMIN_PROTECTION', status: 403 });

      await expect(
        reactivateUser('admin-2', 'Tentativa de reativar outro admin.', 'admin-1')
      ).rejects.toMatchObject({ code: 'ADMIN_PROTECTION', status: 403 });

      await expect(
        approveUser('admin-2', 'ANALYST', 'admin-1')
      ).rejects.toMatchObject({ code: 'ADMIN_PROTECTION', status: 403 });

      await expect(
        resendProvisionalPassword('admin-2', 'admin-1')
      ).rejects.toMatchObject({ code: 'ADMIN_PROTECTION', status: 403 });
    });
  });

  describe('Adicionar usuário (createUser) integrado ao primeiro acesso', () => {
    it('cadastra usuário com perfil operacional persistindo inativo primeiro e ativa após envio aceito', async () => {
      mock.database.user.findUnique.mockResolvedValue(null);
      mock.database.user.create.mockResolvedValue({
        ...publicUser,
        id: 'new-analyst-1',
        name: 'Mariana Fernandes',
        email: 'mariana@empresa.com',
        role: 'ANALYST',
        active: false,
        approvedAt: null,
      });
      mock.database.user.update.mockResolvedValue({
        ...publicUser,
        id: 'new-analyst-1',
        name: 'Mariana Fernandes',
        email: 'mariana@empresa.com',
        role: 'ANALYST',
        active: true,
        approvedAt: now,
      });

      const emailSpy = vi.spyOn(emailService, 'sendProvisionalPasswordEmail').mockResolvedValueOnce({
        success: true,
        delivered: true,
        adapter: 'smtp',
        messageId: 'msg-123',
      });

      const res = await createUser(
        { name: 'Mariana Fernandes', email: 'mariana@empresa.com', role: 'ANALYST' },
        'admin-1'
      );

      // Persistiu primeiro como inativo
      expect(mock.database.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: 'Mariana Fernandes',
            email: 'mariana@empresa.com',
            role: 'ANALYST',
            active: false,
            approvedAt: null,
            mustChangePassword: true,
          }),
        })
      );

      // Enviou e-mail somente após persistência
      expect(emailSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'mariana@empresa.com',
          name: 'Mariana Fernandes',
        })
      );

      // Ativou a conta após o envio aceito
      expect(mock.database.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'new-analyst-1' },
          data: expect.objectContaining({
            active: true,
            approvedById: 'admin-1',
          }),
        })
      );

      expect(res.active).toBe(true);
      expect(res.emailDelivery.delivered).toBe(true);
      expect(res.emailDelivery.statusMessage).toBe('Envio aceito pelo servidor de e-mail; conta ativada');
      expect((res as Record<string, unknown>).previewPassword).toBeUndefined();
      expect((res.emailDelivery as Record<string, unknown>).previewPassword).toBeUndefined();
      expect(mock.database.adminAudit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ type: 'ACCESS_APPROVED', actorId: 'admin-1' }),
      });
    });

    it('mantém conta inativa se a entrega do e-mail não for confirmada e não expõe senha', async () => {
      mock.database.user.findUnique.mockResolvedValue(null);
      mock.database.user.create.mockResolvedValue({
        ...publicUser,
        id: 'new-viewer-1',
        name: 'Roberto Costa',
        email: 'roberto@empresa.com',
        role: 'VIEWER',
        active: false,
        approvedAt: null,
      });

      vi.spyOn(emailService, 'sendProvisionalPasswordEmail').mockResolvedValueOnce({
        success: true,
        delivered: false,
        adapter: 'local-preview',
        messageId: 'preview-id',
      });

      const res = await createUser(
        { name: 'Roberto Costa', email: 'roberto@empresa.com', role: 'VIEWER' },
        'admin-1'
      );

      expect(res.active).toBe(false);
      expect(res.approvedAt).toBeNull();
      expect(res.emailDelivery.delivered).toBe(false);
      expect(res.emailDelivery.statusMessage).toBe('E-mail não enviado; conta inativa');
      expect((res as Record<string, unknown>).previewPassword).toBeUndefined();
      expect((res.emailDelivery as Record<string, unknown>).previewPassword).toBeUndefined();

      // Não deve ter ativado o usuário
      expect(mock.database.user.update).not.toHaveBeenCalled();
    });

    it('se a persistência inicial falhar (ex: erro no banco), NÃO tenta enviar e-mail', async () => {
      mock.database.user.findUnique.mockResolvedValue(null);
      mock.database.user.create.mockRejectedValueOnce(new Error('Falha de conexão com banco de dados'));

      const emailSpy = vi.spyOn(emailService, 'sendProvisionalPasswordEmail');

      await expect(
        createUser({ name: 'Falha DB', email: 'db-fail@empresa.com', role: 'ANALYST' }, 'admin-1')
      ).rejects.toThrow('Falha de conexão com banco de dados');

      expect(emailSpy).not.toHaveBeenCalled();
    });

    it('rejeita cadastro se e-mail já estiver cadastrado no sistema', async () => {
      mock.database.user.findUnique.mockResolvedValue(publicUser);

      await expect(
        createUser(
          { name: 'Duplicado', email: 'person@example.test', role: 'ANALYST' },
          'admin-1'
        )
      ).rejects.toMatchObject({ code: 'EMAIL_ALREADY_REGISTERED', status: 409 });
    });
  });

  describe('Reenvio de senha provisória e proteção de credenciais existentes', () => {
    it('preserva credenciais e sessões ativas quando o reenvio de e-mail não é aceito', async () => {
      mock.database.user.findUnique.mockResolvedValue({
        ...publicUser,
        id: 'user-active-1',
        active: true,
        approvedAt: now,
        rejectedAt: null,
      });

      vi.spyOn(emailService, 'sendProvisionalPasswordEmail').mockResolvedValueOnce({
        success: true,
        delivered: false,
        adapter: 'local-preview',
      });

      const res = await resendProvisionalPassword('user-active-1', 'admin-1');

      // Não atualizou hash nem revogou sessões
      expect(mock.database.user.update).not.toHaveBeenCalled();
      expect(mock.database.authSession.updateMany).not.toHaveBeenCalled();
      expect(res.emailDelivery.delivered).toBe(false);
      expect(res.emailDelivery.statusMessage).toBe('E-mail não enviado; credenciais anteriores preservadas');
      expect((res as Record<string, unknown>).previewPassword).toBeUndefined();
      expect((res.emailDelivery as Record<string, unknown>).previewPassword).toBeUndefined();
    });

    it('em falha do servidor SMTP no reenvio, preserva credenciais e lança EMAIL_DELIVERY_FAILED', async () => {
      mock.database.user.findUnique.mockResolvedValue({
        ...publicUser,
        id: 'user-active-1',
        active: true,
        approvedAt: now,
        rejectedAt: null,
      });

      vi.spyOn(emailService, 'sendProvisionalPasswordEmail').mockResolvedValueOnce({
        success: false,
        delivered: false,
        adapter: 'smtp',
      });

      await expect(
        resendProvisionalPassword('user-active-1', 'admin-1')
      ).rejects.toMatchObject({
        code: 'EMAIL_DELIVERY_FAILED',
        status: 502,
      });

      expect(mock.database.user.update).not.toHaveBeenCalled();
      expect(mock.database.authSession.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('Proteção contra promoção não governada para Administrador', () => {
    it('impede promoção para Administrador na gestão de equipe (ADMIN_PROMOTION_DISABLED)', async () => {
      await expect(
        changeUserRole('user-1', { role: 'ADMIN' as any }, 'admin-1')
      ).rejects.toMatchObject({
        code: 'ADMIN_PROMOTION_DISABLED',
        status: 422,
      });
    });
  });

  describe('Exclusão de Usuários (com e sem histórico, casos operacionais e descontinuação de reativação)', () => {
    it('transfere somente casos abertos, anonimiza dados pessoais e credenciais, revoga sessões e registra auditoria para usuário com histórico', async () => {
      mock.database.user.findUnique.mockResolvedValue({
        ...publicUser,
        role: 'ANALYST',
        _count: { comments: 2, createdCases: 0, activities: 1, assignedCases: 1, attachmentsAuthored: 0, attachmentsDeleted: 0, documentImports: 0, auditsAuthored: 0 },
      });
      mock.database.sacRecord.findMany.mockResolvedValue([{ id: 'case-1', ticket: 'SAC-1' }]);
      mock.database.user.findFirst.mockResolvedValue({ id: 'analyst-2', name: 'Responsável' });
      mock.database.sacRecord.count.mockResolvedValue(1);

      const result = await deleteUser('user-1', { justification: 'Mudança de área.', strategy: 'transfer', transferToUserId: 'analyst-2' }, 'admin-1');

      expect(mock.database.sacRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: { in: ['PENDING', 'IN_PROGRESS'] } }) })
      );
      expect(mock.database.sacRecord.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ assigneeId: 'analyst-2', lastOperationalActivityAt: expect.any(Date) }) })
      );
      expect(mock.database.activityLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ eventType: 'CASE_TRANSFERRED' }),
      });
      expect(mock.database.notification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ recipientId: 'analyst-2', type: 'ASSIGNEE_CHANGED' }),
      });
      expect(mock.database.authSession.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      });
      expect(mock.database.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: 'Usuário Excluído',
            active: false,
            deletedAt: expect.any(Date),
            mustChangePassword: false,
            provisionalPasswordHash: null,
          }),
        })
      );
      expect(mock.database.adminAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'USER_DELETED',
            metadata: expect.objectContaining({ mode: 'anonymized_history_preserved' }),
          }),
        })
      );
      expect(result).toMatchObject({ mode: 'anonymized', deleted: true });
    });

    it('exclui fisicamente a conta e revoga sessões quando o usuário não possui histórico associado', async () => {
      mock.database.user.findUnique.mockResolvedValue({
        ...publicUser,
        role: 'ANALYST',
        _count: { comments: 0, createdCases: 0, activities: 0, assignedCases: 0, attachmentsAuthored: 0, attachmentsDeleted: 0, documentImports: 0, auditsAuthored: 0 },
      });
      mock.database.sacRecord.findMany.mockResolvedValue([]);
      mock.database.sacRecord.count.mockResolvedValue(0);

      const result = await deleteUser('user-1', { justification: 'Conta criada por engano.' }, 'admin-1');

      expect(mock.database.authSession.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
      expect(mock.database.notification.deleteMany).toHaveBeenCalledWith({ where: { recipientId: 'user-1' } });
      expect(mock.database.user.delete).toHaveBeenCalledWith({ where: { id: 'user-1' } });
      const auditCall = mock.database.adminAudit.create.mock.calls.find(
        (call: any[]) => call[0]?.data?.type === 'USER_DELETED'
      );
      expect(auditCall).toBeDefined();
      const auditData = auditCall![0].data;
      expect(auditData.targetUserId).toBeNull();
      expect(auditData.metadata).toMatchObject({
        mode: 'physical_deletion',
        deletedUserId: 'user-1',
        deletedUserRole: 'ANALYST',
        hasHistory: false,
      });
      // Garante ausência total de dados pessoais ou credenciais retidas na auditoria
      expect(auditData.metadata.deletedUserName).toBeUndefined();
      expect(auditData.metadata.deletedUserEmail).toBeUndefined();
      expect(auditData.metadata.password).toBeUndefined();
      expect(auditData.metadata.passwordHash).toBeUndefined();

      expect(result).toMatchObject({ mode: 'physical', deleted: true, id: 'user-1' });
    });

    it('preserva conta anonimizada e histórico de auditoria quando o único vínculo histórico é ser alvo de registros em AdminAudit (auditsReceived > 0)', async () => {
      mock.database.user.findUnique.mockResolvedValue({
        ...publicUser,
        id: 'user-audit-target',
        name: 'Maria Auditoria',
        email: 'maria.audit@sac.local',
        role: 'ANALYST',
        _count: {
          comments: 0,
          createdCases: 0,
          activities: 0,
          assignedCases: 0,
          attachmentsAuthored: 0,
          attachmentsDeleted: 0,
          documentImports: 0,
          auditsAuthored: 0,
          auditsReceived: 2, // Único vínculo histórico: 2 eventos em AdminAudit como alvo
          approvedUsers: 0,
        },
      });
      mock.database.sacRecord.findMany.mockResolvedValue([]);
      mock.database.sacRecord.count.mockResolvedValue(0);

      const result = await deleteUser(
        'user-audit-target',
        { justification: 'Exclusão com preservação de auditorias recebidas.' },
        'admin-1'
      );

      // Não deve sofrer exclusão física para não quebrar nem orfanar os registros de auditoria anteriores
      expect(mock.database.user.delete).not.toHaveBeenCalled();

      // Atualiza a conta aplicando anonimização LGPD e neutralização de credenciais
      expect(mock.database.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'user-audit-target' },
          data: expect.objectContaining({
            name: 'Usuário Excluído',
            email: expect.stringMatching(/^deleted_user-audit-target_\d+@sac\.local$/),
            passwordHash: expect.stringMatching(/^EXCLUDED_/),
            active: false,
            deletedAt: expect.any(Date),
            mustChangePassword: false,
            provisionalPasswordHash: null,
            passwordResetTokenHash: null,
          }),
        })
      );

      // Evento USER_DELETED registra targetUserId associado, preservando a trilha histórica
      expect(mock.database.adminAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'USER_DELETED',
            targetUserId: 'user-audit-target',
            metadata: expect.objectContaining({
              mode: 'anonymized_history_preserved',
              deletedUserId: 'user-audit-target',
              hasHistory: true,
            }),
          }),
        })
      );

      // Metadados não expõem e-mail, nome original nem senhas
      const auditCall = mock.database.adminAudit.create.mock.calls.find(
        (call: any[]) => call[0]?.data?.type === 'USER_DELETED' && call[0]?.data?.targetUserId === 'user-audit-target'
      );
      expect(auditCall).toBeDefined();
      expect(auditCall![0].data.metadata.deletedUserName).toBeUndefined();
      expect(auditCall![0].data.metadata.deletedUserEmail).toBeUndefined();
      expect(auditCall![0].data.metadata.password).toBeUndefined();

      expect(result).toMatchObject({ mode: 'anonymized', deleted: true });
    });

    it('exige estratégia de destino quando há casos abertos atribuídos', async () => {
      mock.database.user.findUnique.mockResolvedValue({
        ...publicUser,
        role: 'ANALYST',
        _count: { comments: 0, createdCases: 0, activities: 0, assignedCases: 1 },
      });
      mock.database.sacRecord.findMany.mockResolvedValue([{ id: 'case-1', ticket: 'SAC-1' }]);

      await expect(
        deleteUser('user-1', {}, 'admin-1')
      ).rejects.toMatchObject({
        code: 'CASE_DESTINATION_REQUIRED',
        status: 422,
      });
    });

    it('exige confirmação explícita para deixar casos sem responsável', async () => {
      mock.database.user.findUnique.mockResolvedValue({
        ...publicUser,
        role: 'ANALYST',
        _count: { comments: 0, createdCases: 0, activities: 0, assignedCases: 1 },
      });
      mock.database.sacRecord.findMany.mockResolvedValue([{ id: 'case-1', ticket: 'SAC-1' }]);

      await expect(
        deleteUser('user-1', { strategy: 'unassigned' }, 'admin-1')
      ).rejects.toMatchObject({
        code: 'UNASSIGN_CONFIRMATION_REQUIRED',
        status: 422,
      });
    });

    it('permite deixar casos sem responsável com confirmação explícita', async () => {
      mock.database.user.findUnique.mockResolvedValue({
        ...publicUser,
        role: 'ANALYST',
        _count: { comments: 1, createdCases: 0, activities: 0, assignedCases: 1, attachmentsAuthored: 0, attachmentsDeleted: 0, documentImports: 0, auditsAuthored: 0 },
      });
      mock.database.sacRecord.findMany.mockResolvedValue([{ id: 'case-1', ticket: 'SAC-1' }]);
      mock.database.sacRecord.count.mockResolvedValue(0);

      const result = await deleteUser('user-1', { strategy: 'unassigned', confirmUnassigned: true }, 'admin-1');

      expect(mock.database.sacRecord.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ assigneeId: null }) })
      );
      expect(mock.database.activityLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ eventType: 'CASE_TRANSFERRED' }),
      });
      expect(mock.database.authSession.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
      expect(result).toMatchObject({ mode: 'anonymized', deleted: true });
    });

    it('impede autoexclusão de administrador (SELF_ACTION_BLOCKED)', async () => {
      mock.database.user.findUnique.mockResolvedValue({
        ...publicUser,
        id: 'admin-1',
        role: 'ADMIN',
      });

      await expect(
        deleteUser('admin-1', {}, 'admin-1')
      ).rejects.toMatchObject({
        code: 'SELF_ACTION_BLOCKED',
        status: 403,
      });
    });

    it('impede exclusão de outro administrador (ADMIN_PROTECTION)', async () => {
      mock.database.user.findUnique.mockResolvedValue({
        ...publicUser,
        id: 'admin-2',
        role: 'ADMIN',
      });

      await expect(
        deleteUser('admin-2', {}, 'admin-1')
      ).rejects.toMatchObject({
        code: 'ADMIN_PROTECTION',
        status: 403,
      });
    });

    it('rejeita exclusão de usuário inexistente ou já excluído', async () => {
      mock.database.user.findUnique.mockResolvedValue(null);
      await expect(deleteUser('user-not-found', {}, 'admin-1')).rejects.toMatchObject({
        code: 'USER_NOT_FOUND',
        status: 404,
      });

      mock.database.user.findUnique.mockResolvedValue({
        ...publicUser,
        deletedAt: new Date(),
      });
      await expect(deleteUser('user-deleted', {}, 'admin-1')).rejects.toMatchObject({
        code: 'USER_NOT_FOUND',
        status: 404,
      });
    });

    it('rejeita tentativa de inativação informando a descontinuação do fluxo (DEACTIVATION_DISCONTINUED)', async () => {
      mock.database.user.findUnique.mockResolvedValue({ ...publicUser, role: 'ANALYST', active: true });
      await expect(
        deactivateUser('user-1', { justification: 'Não necessário.' }, 'admin-1')
      ).rejects.toMatchObject({
        code: 'DEACTIVATION_DISCONTINUED',
        status: 410,
      });
      expect(mock.database.user.update).not.toHaveBeenCalled();
    });

    it('impede inativação na própria conta ou em outro administrador', async () => {
      mock.database.user.findUnique.mockResolvedValue({ ...publicUser, id: 'admin-1', role: 'ADMIN' });
      await expect(
        deactivateUser('admin-1', {}, 'admin-1')
      ).rejects.toMatchObject({
        code: 'SELF_ACTION_BLOCKED',
        status: 403,
      });

      mock.database.user.findUnique.mockResolvedValue({ ...publicUser, id: 'admin-2', role: 'ADMIN' });
      await expect(
        deactivateUser('admin-2', {}, 'admin-1')
      ).rejects.toMatchObject({
        code: 'ADMIN_PROTECTION',
        status: 403,
      });
    });

    it('rejeita tentativa de reativação informando a descontinuação do fluxo (REACTIVATION_DISCONTINUED)', async () => {
      mock.database.user.findUnique.mockResolvedValue({ ...publicUser, role: 'ANALYST', active: false, approvedAt: now, rejectedAt: null });
      await expect(
        reactivateUser('user-1', 'Retorno à operação.', 'admin-1')
      ).rejects.toMatchObject({
        code: 'REACTIVATION_DISCONTINUED',
        status: 410,
      });
      expect(mock.database.user.update).not.toHaveBeenCalled();
    });

    it('impede reativação na própria conta ou em outro administrador', async () => {
      mock.database.user.findUnique.mockResolvedValue({ ...publicUser, id: 'admin-1', role: 'ADMIN' });
      await expect(
        reactivateUser('admin-1', 'Motivo', 'admin-1')
      ).rejects.toMatchObject({
        code: 'SELF_ACTION_BLOCKED',
        status: 403,
      });

      mock.database.user.findUnique.mockResolvedValue({ ...publicUser, id: 'admin-2', role: 'ADMIN' });
      await expect(
        reactivateUser('admin-2', 'Motivo', 'admin-1')
      ).rejects.toMatchObject({
        code: 'ADMIN_PROTECTION',
        status: 403,
      });
    });
  });
});
