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
    },
    sacRecord: {
      findMany: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    activityLog: { create: vi.fn() },
    notification: { create: vi.fn() },
    adminAudit: { create: vi.fn(), findMany: vi.fn() },
    authSession: { updateMany: vi.fn() },
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

  describe('Inativação e Reativação com casos operacionais', () => {
    it('transfere somente casos abertos, registra histórico e notifica o novo responsável', async () => {
      mock.database.user.findUnique.mockResolvedValue({ ...publicUser, role: 'ANALYST' });
      mock.database.sacRecord.findMany.mockResolvedValue([{ id: 'case-1', ticket: 'SAC-1' }]);
      mock.database.user.findFirst.mockResolvedValue({ id: 'analyst-2', name: 'Responsável' });

      await deactivateUser('user-1', { justification: 'Mudança de área.', strategy: 'transfer', transferToUserId: 'analyst-2' }, 'admin-1');

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
      expect(mock.database.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { active: false, tokenVersion: { increment: 1 } } })
      );
    });

    it('reativa conta aprovada sem devolver casos anteriores', async () => {
      mock.database.user.findUnique.mockResolvedValue({ ...publicUser, role: 'ANALYST', active: false, approvedAt: now, rejectedAt: null });
      await reactivateUser('user-1', 'Retorno à operação.', 'admin-1');
      expect(mock.database.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { active: true, tokenVersion: { increment: 1 } } })
      );
      expect(mock.database.sacRecord.update).not.toHaveBeenCalled();
    });
  });
});
