import { randomUUID } from 'node:crypto';
import { Prisma, type UserRole } from '@prisma/client';
import type { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { createCaseNotification } from '../notifications/notification.service.js';
import { generateProvisionalPassword, hashPassword } from '../../lib/auth/provisional-password.js';
import { sendProvisionalPasswordEmail } from '../../lib/email/email.service.js';
import { DEFAULT_USER_DEPARTMENTS, type changeRoleSchema, type createUserSchema, type deactivateUserSchema, type deleteUserSchema, type listUsersSchema } from './users.schema.js';

type ListInput = z.infer<typeof listUsersSchema>;
type ChangeRoleInput = z.infer<typeof changeRoleSchema>;
type DeactivateInput = z.infer<typeof deactivateUserSchema>;
type DeleteUserInput = z.infer<typeof deleteUserSchema>;
type CreateUserInput = z.infer<typeof createUserSchema>;
export class UserManagementError extends Error { constructor(public code: string, message: string, public status: number) { super(message); } }
const userSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  department: true,
  active: true,
  approvedAt: true,
  rejectedAt: true,
  lastLoginAt: true,
  createdAt: true,
  mustChangePassword: true,
  provisionalPasswordExpiresAt: true,
} as const;
const ADMIN_LOCK = Prisma.sql`SELECT pg_advisory_xact_lock(734221, 7)`;

function approvalWhere(value: ListInput['approval']): Prisma.UserWhereInput {
  if (value === 'pending') return { approvedAt: null, rejectedAt: null };
  if (value === 'approved') return { approvedAt: { not: null }, rejectedAt: null };
  if (value === 'rejected') return { rejectedAt: { not: null } };
  return {};
}

export async function teamSummary() {
  const [activeUsers, pendingApproval, analysts, unassignedCases] = await prisma.$transaction([
    prisma.user.count({ where: { active: true, approvedAt: { not: null }, rejectedAt: null, deletedAt: null } }),
    prisma.user.count({ where: { approvedAt: null, rejectedAt: null, deletedAt: null } }),
    prisma.user.count({ where: { role: 'ANALYST', active: true, approvedAt: { not: null }, rejectedAt: null, deletedAt: null } }),
    prisma.sacRecord.count({ where: { archivedAt: null, status: { in: ['PENDING', 'IN_PROGRESS'] }, assigneeId: null } }),
  ]);
  return { activeUsers, pendingApproval, analysts, unassignedCases };
}

export async function listUsers(input: ListInput) {
  const where: Prisma.UserWhereInput = {
    deletedAt: null,
    ...(input.query ? { OR: [{ name: { contains: input.query, mode: 'insensitive' } }, { email: { contains: input.query, mode: 'insensitive' } }] } : {}),
    ...(input.role !== 'all' ? { role: input.role } : {}), ...(input.state !== 'all' ? { active: input.state === 'active' } : {}), ...approvalWhere(input.approval),
  };
  const orderBy = { [input.sort]: input.order } as Prisma.UserOrderByWithRelationInput;
  const [items, total] = await prisma.$transaction([
    prisma.user.findMany({ where, select: { ...userSelect, _count: { select: { assignedCases: { where: { archivedAt: null, status: { in: ['PENDING', 'IN_PROGRESS'] } } } } } }, orderBy: [orderBy, { id: 'asc' }], skip: (input.page - 1) * input.pageSize, take: input.pageSize }),
    prisma.user.count({ where }),
  ]);
  return { items: items.map(item => ({ ...item, openAssignedCases: item._count.assignedCases, _count: undefined })), total, page: input.page, pageSize: input.pageSize };
}

async function isLastAdministrator(tx: Prisma.TransactionClient, userId: string) {
  await tx.$executeRaw(ADMIN_LOCK);
  return await tx.user.count({ where: { id: { not: userId }, role: 'ADMIN', active: true, approvedAt: { not: null }, rejectedAt: null, deletedAt: null } }) === 0;
}

async function revokeSessions(tx: Prisma.TransactionClient, userId: string, revokedAt = new Date()) {
  return tx.authSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt } });
}

function lastAdminError() { return new UserManagementError('LAST_ADMIN_PROTECTED', 'Mantenha pelo menos um administrador ativo e aprovado.', 409); }

function assertAdminActionAllowed(targetUser: { id: string; role: UserRole }, actorId: string, actionName: string = 'alterar') {
  if (targetUser.id === actorId) {
    throw new UserManagementError(
      'SELF_ACTION_BLOCKED',
      'Não é permitido executar ações administrativas na própria conta.',
      403
    );
  }
  if (targetUser.role === 'ADMIN') {
    throw new UserManagementError(
      'ADMIN_PROTECTION',
      `Não é permitido ${actionName} outro administrador.`,
      403
    );
  }
}

export async function approveUser(targetUserId: string, role: 'ANALYST' | 'VIEWER', actorId: string, department?: string | null) {
  const current = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { ...userSelect, approvedById: true },
  });
  if (!current) throw new UserManagementError('USER_NOT_FOUND', 'Usuário não encontrado.', 404);
  assertAdminActionAllowed(current, actorId, 'aprovar');
  if (current.approvedAt && current.active && !current.rejectedAt) {
    return {
      ...current,
      emailDelivery: {
        success: true,
        delivered: true,
        adapter: 'none',
        statusMessage: 'Usuário já aprovado',
      },
    };
  }

  const provisionalPassword = generateProvisionalPassword();
  const provisionalPasswordHash = await hashPassword(provisionalPassword);
  const now = new Date();
  const provisionalPasswordExpiresAt = new Date(Date.now() + 48 * 3600 * 1000);

  // 1. Tentar envio de e-mail ANTES de ativar o usuário
  const emailResult = await sendProvisionalPasswordEmail({
    to: current.email,
    name: current.name,
    provisionalPassword,
    expiresAt: provisionalPasswordExpiresAt,
  });

  // 2. Se o envio de e-mail falhou (servidor real falhou)
  if (!emailResult.success) {
    await prisma.adminAudit.create({
      data: {
        type: 'PROVISIONAL_PASSWORD_GENERATED',
        actorId,
        targetUserId,
        metadata: {
          emailSuccess: false,
          emailDelivered: false,
          error: 'Falha no envio de e-mail',
          adapter: emailResult.adapter,
        },
      },
    });

    throw new UserManagementError(
      'EMAIL_DELIVERY_FAILED',
      'Não foi possível enviar o e-mail com a senha provisória. A solicitação permanece pendente e pode ser tentada novamente.',
      502
    );
  }

  // 3. Se for modo de prévia ou envio não entregue (emailResult.delivered === false)
  // A conta NÃO é ativada pois a ativação exige confirmação de envio pelo servidor de e-mail
  if (!emailResult.delivered) {
    const updated = await prisma.$transaction(async tx => {
      const user = await tx.user.update({
        where: { id: targetUserId },
        data: {
          role,
          active: false, // Permanece inativo
          approvedAt: null, // Ativação pendente até envio real
          mustChangePassword: true,
          passwordHash: provisionalPasswordHash,
          provisionalPasswordHash,
          provisionalPasswordCreatedAt: now,
          provisionalPasswordExpiresAt,
          rejectedAt: null,
          rejectionReason: null,
        },
        select: userSelect,
      });

      await tx.adminAudit.create({
        data: {
          type: 'PROVISIONAL_PASSWORD_GENERATED',
          actorId,
          targetUserId,
          metadata: {
            expiresAt: provisionalPasswordExpiresAt.toISOString(),
            emailDelivered: false,
            emailSuccess: true,
            emailAdapter: emailResult.adapter,
            statusMessage: 'E-mail não enviado; conta inativa',
            previewMode: true,
          },
        },
      });

      return user;
    });

    return {
      ...updated,
      emailDelivery: {
        success: true,
        delivered: false,
        adapter: emailResult.adapter,
        statusMessage: 'E-mail não enviado; conta inativa',
        expiresAt: provisionalPasswordExpiresAt,
      },
    };
  }

  // 4. Se a entrega real foi aceita pelo servidor SMTP (emailResult.delivered === true)
  const { user, sessionsRevoked } = await prisma.$transaction(async tx => {
    const updated = await tx.user.update({
      where: { id: targetUserId },
      data: {
        role,
        ...(department !== undefined ? { department: department?.trim() || null } : {}),
        active: true,
        approvedAt: now,
        approvedById: actorId,
        rejectedAt: null,
        rejectionReason: null,
        tokenVersion: { increment: 1 },
        passwordHash: provisionalPasswordHash,
        mustChangePassword: true,
        provisionalPasswordHash,
        provisionalPasswordCreatedAt: now,
        provisionalPasswordExpiresAt,
      },
      select: userSelect,
    });

    const sessions = await revokeSessions(tx, targetUserId, now);

    await tx.adminAudit.create({
      data: {
        type: 'ACCESS_APPROVED',
        actorId,
        targetUserId,
        metadata: {
          role,
          sessionsRevoked: sessions.count,
          emailDelivered: true,
          emailSuccess: true,
          emailAdapter: emailResult.adapter,
          statusMessage: 'Envio aceito pelo servidor de e-mail; conta ativada',
        },
      },
    });

    await tx.adminAudit.create({
      data: {
        type: 'PROVISIONAL_PASSWORD_GENERATED',
        actorId,
        targetUserId,
        metadata: {
          expiresAt: provisionalPasswordExpiresAt.toISOString(),
          emailDelivered: true,
          emailSuccess: true,
          emailAdapter: emailResult.adapter,
        },
      },
    });

    return { user: updated, sessionsRevoked: sessions.count };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  return {
    ...user,
    emailDelivery: {
      success: true,
      delivered: true,
      adapter: emailResult.adapter,
      statusMessage: 'Envio aceito pelo servidor de e-mail; conta ativada',
    },
  };
}

export async function completeActivation(_targetUserId: string, _actorId: string) {
  throw new UserManagementError(
    'MANUAL_ACTIVATION_DISABLED',
    'A ativação manual foi desabilitada. A conta só pode ser ativada após a confirmação de envio pelo servidor de e-mail.',
    400
  );
}

export async function resendProvisionalPassword(targetUserId: string, actorId: string) {
  const current = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { ...userSelect, approvedById: true },
  });
  if (!current) throw new UserManagementError('USER_NOT_FOUND', 'Usuário não encontrado.', 404);
  assertAdminActionAllowed(current, actorId, 'reenviar senha para');
  if (!current.approvedAt || current.rejectedAt) {
    throw new UserManagementError('USER_NOT_APPROVED', 'Apenas usuários aprovados podem receber nova senha provisória.', 422);
  }
  if (!current.active) {
    throw new UserManagementError('USER_INACTIVE', 'Usuário inativo não pode receber nova senha provisória.', 422);
  }

  const provisionalPassword = generateProvisionalPassword();
  const provisionalPasswordHash = await hashPassword(provisionalPassword);
  const now = new Date();
  const provisionalPasswordExpiresAt = new Date(Date.now() + 48 * 3600 * 1000);

  // 1. Tentar envio de e-mail ANTES de invalidar senha anterior
  const emailResult = await sendProvisionalPasswordEmail({
    to: current.email,
    name: current.name,
    provisionalPassword,
    expiresAt: provisionalPasswordExpiresAt,
  });

  if (!emailResult.success) {
    await prisma.adminAudit.create({
      data: {
        type: 'PROVISIONAL_PASSWORD_RESENT',
        actorId,
        targetUserId,
        metadata: {
          emailSuccess: false,
          emailDelivered: false,
          error: 'Falha no reenvio de e-mail',
          adapter: emailResult.adapter,
          statusMessage: 'Falha no envio de e-mail; credenciais anteriores preservadas',
        },
      },
    });

    throw new UserManagementError(
      'EMAIL_DELIVERY_FAILED',
      'Não foi possível reenviar o e-mail com a senha provisória. As credenciais anteriores foram preservadas.',
      502
    );
  }

  // Se o envio não foi aceito pelo servidor de e-mail (modo de prévia ou não entregue),
  // PRESERVA as credenciais e sessões existentes sem invalidar o acesso atual do usuário
  if (!emailResult.delivered) {
    await prisma.adminAudit.create({
      data: {
        type: 'PROVISIONAL_PASSWORD_RESENT',
        actorId,
        targetUserId,
        metadata: {
          emailDelivered: false,
          emailSuccess: true,
          emailAdapter: emailResult.adapter,
          statusMessage: 'E-mail não enviado; credenciais anteriores preservadas',
        },
      },
    });

    return {
      ...current,
      emailDelivery: {
        success: true,
        delivered: false,
        adapter: emailResult.adapter,
        statusMessage: 'E-mail não enviado; credenciais anteriores preservadas',
        expiresAt: current.provisionalPasswordExpiresAt,
      },
    };
  }

  // Envio aceito pelo servidor SMTP -> atualiza hash da senha e revoga sessões anteriores
  const updatedUser = await prisma.$transaction(async tx => {
    const updated = await tx.user.update({
      where: { id: targetUserId },
      data: {
        passwordHash: provisionalPasswordHash,
        mustChangePassword: true,
        provisionalPasswordHash,
        provisionalPasswordCreatedAt: now,
        provisionalPasswordExpiresAt,
        tokenVersion: { increment: 1 },
      },
      select: userSelect,
    });

    await revokeSessions(tx, targetUserId, now);

    await tx.adminAudit.create({
      data: {
        type: 'PROVISIONAL_PASSWORD_RESENT',
        actorId,
        targetUserId,
        metadata: {
          expiresAt: provisionalPasswordExpiresAt.toISOString(),
          emailDelivered: true,
          emailSuccess: true,
          emailAdapter: emailResult.adapter,
          statusMessage: 'Envio aceito pelo servidor de e-mail',
        },
      },
    });

    return updated;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  return {
    ...updatedUser,
    emailDelivery: {
      success: true,
      delivered: true,
      adapter: emailResult.adapter,
      statusMessage: 'Envio aceito pelo servidor de e-mail',
      expiresAt: provisionalPasswordExpiresAt,
    },
  };
}

export async function rejectUser(targetUserId: string, reason: string, actorId: string) {
  const result = await prisma.$transaction(async tx => {
    const current = await tx.user.findUnique({ where: { id: targetUserId }, select: { role: true, active: true, approvedAt: true, rejectedAt: true } });
    if (!current) throw new UserManagementError('USER_NOT_FOUND', 'Usuário não encontrado.', 404);
    assertAdminActionAllowed({ id: targetUserId, role: current.role }, actorId, 'recusar');
    if (current.rejectedAt) return { blocked: false as const, user: await tx.user.findUniqueOrThrow({ where: { id: targetUserId }, select: userSelect }) };
    if (current.role === 'ADMIN' && current.active && current.approvedAt && await isLastAdministrator(tx, targetUserId)) { await tx.adminAudit.create({ data: { type: 'LAST_ADMIN_BLOCKED', actorId, targetUserId, metadata: { action: 'reject' } } }); return { blocked: true as const }; }
    if (current.approvedAt) throw new UserManagementError('USER_ALREADY_APPROVED', 'Use a inativação para uma conta já aprovada.', 422);
    const user = await tx.user.update({ where: { id: targetUserId }, data: { active: false, approvedAt: null, approvedById: null, rejectedAt: new Date(), rejectionReason: reason, tokenVersion: { increment: 1 } }, select: userSelect });
    const sessions = await revokeSessions(tx, targetUserId);
    await tx.adminAudit.create({ data: { type: 'ACCESS_REJECTED', actorId, targetUserId, justification: reason, metadata: { sessionsRevoked: sessions.count } } }); return { blocked: false as const, user };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  if (result.blocked) throw lastAdminError(); return result.user;
}

const roleRank: Record<UserRole, number> = { VIEWER: 1, ANALYST: 2, ADMIN: 3 };
export async function changeUserRole(targetUserId: string, input: ChangeRoleInput, actorId: string) {
  if ((input.role as string) === 'ADMIN') {
    throw new UserManagementError(
      'ADMIN_PROMOTION_DISABLED',
      'A alteração para perfil Administrador não é permitida pela gestão de equipe.',
      422
    );
  }

  const result = await prisma.$transaction(async tx => {
    const current = await tx.user.findUnique({ where: { id: targetUserId }, select: { role: true, active: true, approvedAt: true, rejectedAt: true } });
    if (!current) throw new UserManagementError('USER_NOT_FOUND', 'Usuário não encontrado.', 404);
    assertAdminActionAllowed({ id: targetUserId, role: current.role }, actorId, 'alterar perfil de');
    if (current.role === input.role) return { blocked: false as const, user: await tx.user.findUniqueOrThrow({ where: { id: targetUserId }, select: userSelect }) };
    if (!current.approvedAt || current.rejectedAt) throw new UserManagementError('USER_NOT_APPROVED', 'Aprove a conta antes de alterar seu perfil.', 422);
    const needsReason = roleRank[input.role] < roleRank[current.role];
    if (needsReason && !input.justification?.trim()) throw new UserManagementError('JUSTIFICATION_REQUIRED', 'Informe a justificativa para esta alteração de perfil.', 422);
    if (current.role === 'ADMIN' && (input.role as string) !== 'ADMIN' && current.active && current.approvedAt && await isLastAdministrator(tx, targetUserId)) { await tx.adminAudit.create({ data: { type: 'LAST_ADMIN_BLOCKED', actorId, targetUserId, metadata: { action: 'role-change' } } }); return { blocked: true as const }; }
    const user = await tx.user.update({ where: { id: targetUserId }, data: { role: input.role, tokenVersion: { increment: 1 } }, select: userSelect });
    const sessions = await revokeSessions(tx, targetUserId);
    await tx.adminAudit.create({ data: { type: 'ROLE_CHANGED', actorId, targetUserId, justification: input.justification, metadata: { from: current.role, to: input.role, sessionsRevoked: sessions.count } } }); return { blocked: false as const, user };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  if (result.blocked) throw lastAdminError(); return result.user;
}

export async function deleteUser(targetUserId: string, input: DeleteUserInput, actorId: string) {
  const result = await prisma.$transaction(async tx => {
    const current = await tx.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        active: true,
        approvedAt: true,
        rejectedAt: true,
        deletedAt: true,
        createdAt: true,
        tokenVersion: true,
        _count: {
          select: {
            createdCases: true,
            comments: true,
            activities: true,
            assignedCases: true,
            attachmentsAuthored: true,
            attachmentsDeleted: true,
            documentImports: true,
            auditsAuthored: true,
            auditsReceived: true,
            approvedUsers: true,
          },
        },
      },
    });

    if (!current || current.deletedAt) {
      throw new UserManagementError('USER_NOT_FOUND', 'Usuário não encontrado.', 404);
    }

    assertAdminActionAllowed({ id: targetUserId, role: current.role }, actorId, 'excluir');

    if (current.role === 'ADMIN' && current.approvedAt && await isLastAdministrator(tx, targetUserId)) {
      await tx.adminAudit.create({ data: { type: 'LAST_ADMIN_BLOCKED', actorId, targetUserId, metadata: { action: 'delete' } } });
      return { blocked: true as const };
    }

    const openCases = await tx.sacRecord.findMany({
      where: { assigneeId: targetUserId, archivedAt: null, status: { in: ['PENDING', 'IN_PROGRESS'] } },
      select: { id: true, ticket: true },
    });

    if (openCases.length && !input.strategy) {
      throw new UserManagementError('CASE_DESTINATION_REQUIRED', 'Escolha o destino dos casos abertos antes de excluir.', 422);
    }

    let recipient: { id: string; name: string } | null = null;
    if (openCases.length && input.strategy === 'transfer') {
      if (!input.transferToUserId || input.transferToUserId === targetUserId) {
        throw new UserManagementError('INVALID_TRANSFER_TARGET', 'Selecione outro responsável elegível.', 422);
      }
      recipient = await tx.user.findFirst({
        where: {
          id: input.transferToUserId,
          active: true,
          approvedAt: { not: null },
          rejectedAt: null,
          deletedAt: null,
          role: { in: ['ADMIN', 'ANALYST'] },
        },
        select: { id: true, name: true },
      });
      if (!recipient) {
        throw new UserManagementError('INVALID_TRANSFER_TARGET', 'Selecione outro responsável elegível.', 422);
      }
    }

    if (openCases.length && input.strategy === 'unassigned' && !input.confirmUnassigned) {
      throw new UserManagementError('UNASSIGN_CONFIRMATION_REQUIRED', 'Confirme que os casos ficarão sem responsável.', 422);
    }

    const activityAt = new Date();
    for (const record of openCases) {
      await tx.sacRecord.update({
        where: { id: record.id },
        data: { assigneeId: recipient?.id ?? null, lastOperationalActivityAt: activityAt },
      });
      await tx.activityLog.create({
        data: {
          recordId: record.id,
          actorId,
          eventType: 'CASE_TRANSFERRED',
          summary: recipient
            ? `Caso transferido para ${recipient.name} por exclusão do responsável.`
            : 'Caso ficou sem responsável por exclusão do responsável.',
          before: { assigneeId: targetUserId },
          after: { assigneeId: recipient?.id ?? null },
          createdAt: activityAt,
        },
      });
      if (recipient) {
        await createCaseNotification(tx, {
          recipientId: recipient.id,
          actorId,
          recordId: record.id,
          ticket: record.ticket,
          type: 'ASSIGNEE_CHANGED',
          title: 'Caso transferido para você',
          summary: `${record.ticket} foi transferido para sua responsabilidade.`,
          metadata: { ticket: record.ticket },
        });
      }
    }

    const remainingAssignedCount = await tx.sacRecord.count({
      where: { assigneeId: targetUserId },
    });

    const hasHistory =
      (current._count?.createdCases ?? 0) > 0 ||
      (current._count?.comments ?? 0) > 0 ||
      (current._count?.activities ?? 0) > 0 ||
      (current._count?.attachmentsAuthored ?? 0) > 0 ||
      (current._count?.attachmentsDeleted ?? 0) > 0 ||
      (current._count?.documentImports ?? 0) > 0 ||
      (current._count?.auditsAuthored ?? 0) > 0 ||
      (current._count?.auditsReceived ?? 0) > 0 ||
      (current._count?.approvedUsers ?? 0) > 0 ||
      remainingAssignedCount > 0;

    if (!hasHistory) {
      // 1. Exclusão física para contas sem histórico
      await tx.authSession.deleteMany({ where: { userId: targetUserId } });
      await tx.notification.deleteMany({ where: { recipientId: targetUserId } });
      await tx.user.delete({ where: { id: targetUserId } });

      await tx.adminAudit.create({
        data: {
          type: 'USER_DELETED',
          actorId,
          targetUserId: null,
          justification: input.justification || null,
          metadata: {
            mode: 'physical_deletion',
            deletedUserId: targetUserId,
            deletedUserRole: current.role,
            deletedUserCreatedAt: current.createdAt,
            hasHistory: false,
            openCasesCount: openCases.length,
            strategy: input.strategy ?? 'none',
            transferToUserId: recipient?.id ?? null,
          },
        },
      });

      if (openCases.length) {
        await tx.adminAudit.create({
          data: {
            type: 'CASES_TRANSFERRED',
            actorId,
            targetUserId: null,
            metadata: { count: openCases.length, strategy: input.strategy, transferToUserId: recipient?.id ?? null },
          },
        });
      }

      return {
        blocked: false as const,
        deleted: true,
        mode: 'physical' as const,
        id: targetUserId,
        message: 'Usuário excluído com sucesso.',
      };
    } else {
      // 2. Anonimização e remoção de dados pessoais e credenciais para contas com histórico
      const anonymizedName = 'Usuário Excluído';
      const anonymizedEmail = `deleted_${targetUserId}_${Date.now()}@sac.local`;
      const scrambledPasswordHash = `EXCLUDED_${randomUUID()}`;

      await tx.authSession.deleteMany({ where: { userId: targetUserId } });
      await tx.notification.deleteMany({ where: { recipientId: targetUserId } });

      const updated = await tx.user.update({
        where: { id: targetUserId },
        data: {
          name: anonymizedName,
          email: anonymizedEmail,
          passwordHash: scrambledPasswordHash,
          mustChangePassword: false,
          provisionalPasswordHash: null,
          provisionalPasswordCreatedAt: null,
          provisionalPasswordExpiresAt: null,
          passwordResetTokenHash: null,
          passwordResetExpiresAt: null,
          rejectionReason: null,
          active: false,
          deletedAt: activityAt,
          tokenVersion: { increment: 1000 },
        },
        select: userSelect,
      });

      await tx.adminAudit.create({
        data: {
          type: 'USER_DELETED',
          actorId,
          targetUserId,
          justification: input.justification || null,
          metadata: {
            mode: 'anonymized_history_preserved',
            deletedUserId: targetUserId,
            deletedUserRole: current.role,
            hasHistory: true,
            openCasesCount: openCases.length,
            strategy: input.strategy ?? 'none',
            transferToUserId: recipient?.id ?? null,
          },
        },
      });

      if (openCases.length) {
        await tx.adminAudit.create({
          data: {
            type: 'CASES_TRANSFERRED',
            actorId,
            targetUserId,
            metadata: { count: openCases.length, strategy: input.strategy, transferToUserId: recipient?.id ?? null },
          },
        });
      }

      return {
        blocked: false as const,
        deleted: true,
        mode: 'anonymized' as const,
        user: updated,
        message: 'Usuário excluído e dados pessoais anonimizados com sucesso.',
      };
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  if (result.blocked) throw lastAdminError();
  return result;
}

export async function deactivateUser(targetUserId: string, _input: DeactivateInput, actorId: string) {
  const current = await prisma.user.findUnique({ where: { id: targetUserId }, select: { role: true } });
  if (current) assertAdminActionAllowed({ id: targetUserId, role: current.role }, actorId, 'inativar');
  throw new UserManagementError(
    'DEACTIVATION_DISCONTINUED',
    'A inativação de usuários foi descontinuada. O fluxo de gestão de equipe agora utiliza exclusão de usuários.',
    410
  );
}

export async function reactivateUser(targetUserId: string, _reason: string, actorId: string) {
  const current = await prisma.user.findUnique({ where: { id: targetUserId }, select: { role: true } });
  if (current) assertAdminActionAllowed({ id: targetUserId, role: current.role }, actorId, 'reativar');
  throw new UserManagementError(
    'REACTIVATION_DISCONTINUED',
    'A reativação de usuários foi descontinuada. O fluxo de gestão de equipe agora utiliza exclusão de usuários.',
    410
  );
}

export async function createUser(input: CreateUserInput, actorId: string) {
  const normalizedEmail = input.email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) {
    throw new UserManagementError('EMAIL_ALREADY_REGISTERED', 'Já existe um usuário cadastrado com este e-mail.', 409);
  }

  const provisionalPassword = generateProvisionalPassword();
  const provisionalPasswordHash = await hashPassword(provisionalPassword);
  const now = new Date();
  const provisionalPasswordExpiresAt = new Date(Date.now() + 48 * 3600 * 1000);

  // 1. PERSISTIR PRIMEIRO: cria o usuário inativo no banco, apenas com hash da senha provisória
  let createdUser;
  try {
    createdUser = await prisma.$transaction(async tx => {
      const user = await tx.user.create({
        data: {
          name: input.name.trim(),
          email: normalizedEmail,
          role: input.role,
          department: input.department?.trim() || null,
          active: false, // Inativo até envio aceito
          approvedAt: null, // Pendente até envio aceito
          approvedById: null,
          mustChangePassword: true,
          passwordHash: provisionalPasswordHash,
          provisionalPasswordHash,
          provisionalPasswordCreatedAt: now,
          provisionalPasswordExpiresAt,
        },
        select: userSelect,
      });

      await tx.adminAudit.create({
        data: {
          type: 'PROVISIONAL_PASSWORD_GENERATED',
          actorId,
          targetUserId: user.id,
          metadata: {
            role: input.role,
            createdByAdmin: true,
            expiresAt: provisionalPasswordExpiresAt.toISOString(),
            statusMessage: 'Usuário cadastrado inativo; aguardando envio aceito pelo servidor de e-mail',
          },
        },
      });

      return user;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new UserManagementError('EMAIL_ALREADY_REGISTERED', 'Já existe um usuário cadastrado com este e-mail.', 409);
    }
    throw error;
  }

  // 2. DISPARO DO E-MAIL: realizado somente após a persistência bem-sucedida
  let emailResult;
  try {
    emailResult = await sendProvisionalPasswordEmail({
      to: normalizedEmail,
      name: input.name.trim(),
      provisionalPassword,
      expiresAt: provisionalPasswordExpiresAt,
    });
  } catch {
    emailResult = { success: false, delivered: false, adapter: 'error' as const };
  }

  // 3. Se o envio NÃO foi aceito pelo servidor SMTP (modo de prévia ou falha de entrega)
  // A conta permanece inativa e recuperável para aprovação posterior
  if (!emailResult.delivered || !emailResult.success) {
    await prisma.adminAudit.create({
      data: {
        type: 'PROVISIONAL_PASSWORD_GENERATED',
        actorId,
        targetUserId: createdUser.id,
        metadata: {
          role: input.role,
          createdByAdmin: true,
          emailDelivered: false,
          emailSuccess: Boolean(emailResult.success),
          emailAdapter: emailResult.adapter,
          statusMessage: 'E-mail não enviado; conta inativa',
        },
      },
    });

    return {
      ...createdUser,
      emailDelivery: {
        success: Boolean(emailResult.success),
        delivered: false,
        adapter: emailResult.adapter,
        statusMessage: 'E-mail não enviado; conta inativa',
        expiresAt: provisionalPasswordExpiresAt,
      },
    };
  }

  // 4. Envio aceito pelo servidor SMTP -> Ativar a conta
  const activatedUser = await prisma.$transaction(async tx => {
    const updated = await tx.user.update({
      where: { id: createdUser.id },
      data: {
        active: true,
        approvedAt: now,
        approvedById: actorId,
      },
      select: userSelect,
    });

    await tx.adminAudit.create({
      data: {
        type: 'ACCESS_APPROVED',
        actorId,
        targetUserId: createdUser.id,
        metadata: {
          role: input.role,
          createdByAdmin: true,
          emailDelivered: true,
          emailSuccess: true,
          emailAdapter: emailResult.adapter,
          statusMessage: 'Envio aceito pelo servidor de e-mail; conta ativada',
        },
      },
    });

    return updated;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  return {
    ...activatedUser,
    emailDelivery: {
      success: true,
      delivered: true,
      adapter: emailResult.adapter,
      statusMessage: 'Envio aceito pelo servidor de e-mail; conta ativada',
      expiresAt: provisionalPasswordExpiresAt,
    },
  };
}

export async function listUserAudits(targetUserId: string) { return prisma.adminAudit.findMany({ where: { targetUserId }, select: { id: true, type: true, justification: true, metadata: true, createdAt: true, actor: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' }, take: 50 }); }

export async function updateUserDepartment(targetUserId: string, department: string | null | undefined, actorId: string) {
  const current = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { ...userSelect, approvedById: true },
  });
  if (!current) throw new UserManagementError('USER_NOT_FOUND', 'Usuário não encontrado.', 404);
  assertAdminActionAllowed(current, actorId, 'alterar setor de');

  const normalizedDepartment = department?.trim() || null;
  const updated = await prisma.$transaction(async tx => {
    const user = await tx.user.update({
      where: { id: targetUserId },
      data: { department: normalizedDepartment },
      select: userSelect,
    });

    await tx.adminAudit.create({
      data: {
        type: 'ROLE_CHANGED',
        actorId,
        targetUserId,
        metadata: {
          field: 'department',
          previousDepartment: current.department,
          newDepartment: normalizedDepartment,
        },
      },
    });

    return user;
  });

  return updated;
}

export async function listDepartments() {
  const standard: string[] = [...DEFAULT_USER_DEPARTMENTS];
  const [distinctUsers, distinctCases] = await Promise.all([
    prisma.user.findMany({
      where: { department: { not: null }, deletedAt: null },
      select: { department: true },
      distinct: ['department'],
    }),
    prisma.sacRecord.findMany({
      where: { department: { not: null }, archivedAt: null },
      select: { department: true },
      distinct: ['department'],
    }),
  ]);

  const allFound = [
    ...distinctUsers.map(u => u.department?.trim()),
    ...distinctCases.map(c => c.department?.trim()),
  ];

  const custom = allFound
    .filter((d): d is string => Boolean(d && !standard.includes(d as any)));

  return [...new Set([...standard, ...custom])].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

