import { Prisma, type UserRole } from '@prisma/client';
import type { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { createCaseNotification } from '../notifications/notification.service.js';
import type { changeRoleSchema, deactivateUserSchema, listUsersSchema } from './users.schema.js';

type ListInput = z.infer<typeof listUsersSchema>; type ChangeRoleInput = z.infer<typeof changeRoleSchema>; type DeactivateInput = z.infer<typeof deactivateUserSchema>;
export class UserManagementError extends Error { constructor(public code: string, message: string, public status: number) { super(message); } }
const userSelect = { id: true, name: true, email: true, role: true, active: true, approvedAt: true, rejectedAt: true, lastLoginAt: true, createdAt: true } as const;
const ADMIN_LOCK = Prisma.sql`SELECT pg_advisory_xact_lock(734221, 7)`;

function approvalWhere(value: ListInput['approval']): Prisma.UserWhereInput {
  if (value === 'pending') return { approvedAt: null, rejectedAt: null };
  if (value === 'approved') return { approvedAt: { not: null }, rejectedAt: null };
  if (value === 'rejected') return { rejectedAt: { not: null } };
  return {};
}

export async function teamSummary() {
  const [activeUsers, pendingApproval, analysts, unassignedCases] = await prisma.$transaction([
    prisma.user.count({ where: { active: true, approvedAt: { not: null }, rejectedAt: null } }),
    prisma.user.count({ where: { approvedAt: null, rejectedAt: null } }),
    prisma.user.count({ where: { role: 'ANALYST', active: true, approvedAt: { not: null }, rejectedAt: null } }),
    prisma.sacRecord.count({ where: { archivedAt: null, status: { in: ['PENDING', 'IN_PROGRESS'] }, assigneeId: null } }),
  ]);
  return { activeUsers, pendingApproval, analysts, unassignedCases };
}

export async function listUsers(input: ListInput) {
  const where: Prisma.UserWhereInput = {
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
  return await tx.user.count({ where: { id: { not: userId }, role: 'ADMIN', active: true, approvedAt: { not: null }, rejectedAt: null } }) === 0;
}

async function revokeSessions(tx: Prisma.TransactionClient, userId: string, revokedAt = new Date()) {
  return tx.authSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt } });
}

function lastAdminError() { return new UserManagementError('LAST_ADMIN_PROTECTED', 'Mantenha pelo menos um administrador ativo e aprovado.', 409); }

export async function approveUser(targetUserId: string, role: 'ANALYST' | 'VIEWER', actorId: string) {
  return prisma.$transaction(async tx => {
    const current = await tx.user.findUnique({ where: { id: targetUserId }, select: { ...userSelect, approvedById: true } });
    if (!current) throw new UserManagementError('USER_NOT_FOUND', 'Usuário não encontrado.', 404);
    if (current.approvedAt && !current.rejectedAt) return current;
    const approvedAt = new Date();
    const changed = await tx.user.updateMany({ where: { id: targetUserId, approvedAt: null }, data: { role, active: true, approvedAt, approvedById: actorId, rejectedAt: null, rejectionReason: null, tokenVersion: { increment: 1 } } });
    if (!changed.count) return tx.user.findUniqueOrThrow({ where: { id: targetUserId }, select: userSelect });
    const sessions = await revokeSessions(tx, targetUserId, approvedAt);
    await tx.adminAudit.create({ data: { type: 'ACCESS_APPROVED', actorId, targetUserId, metadata: { role, sessionsRevoked: sessions.count } } });
    return tx.user.findUniqueOrThrow({ where: { id: targetUserId }, select: userSelect });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function rejectUser(targetUserId: string, reason: string, actorId: string) {
  const result = await prisma.$transaction(async tx => {
    const current = await tx.user.findUnique({ where: { id: targetUserId }, select: { role: true, active: true, approvedAt: true, rejectedAt: true } });
    if (!current) throw new UserManagementError('USER_NOT_FOUND', 'Usuário não encontrado.', 404);
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
  const result = await prisma.$transaction(async tx => {
    const current = await tx.user.findUnique({ where: { id: targetUserId }, select: { role: true, active: true, approvedAt: true, rejectedAt: true } });
    if (!current) throw new UserManagementError('USER_NOT_FOUND', 'Usuário não encontrado.', 404);
    if (current.role === input.role) return { blocked: false as const, user: await tx.user.findUniqueOrThrow({ where: { id: targetUserId }, select: userSelect }) };
    if (!current.approvedAt || current.rejectedAt) throw new UserManagementError('USER_NOT_APPROVED', 'Aprove a conta antes de alterar seu perfil.', 422);
    const needsReason = input.role === 'ADMIN' || current.role === 'ADMIN' || roleRank[input.role] < roleRank[current.role];
    if (needsReason && !input.justification?.trim()) throw new UserManagementError('JUSTIFICATION_REQUIRED', 'Informe a justificativa para esta alteração de perfil.', 422);
    if (current.role === 'ADMIN' && input.role !== 'ADMIN' && current.active && current.approvedAt && await isLastAdministrator(tx, targetUserId)) { await tx.adminAudit.create({ data: { type: 'LAST_ADMIN_BLOCKED', actorId, targetUserId, metadata: { action: 'role-change' } } }); return { blocked: true as const }; }
    const user = await tx.user.update({ where: { id: targetUserId }, data: { role: input.role, tokenVersion: { increment: 1 } }, select: userSelect });
    const sessions = await revokeSessions(tx, targetUserId);
    await tx.adminAudit.create({ data: { type: 'ROLE_CHANGED', actorId, targetUserId, justification: input.justification, metadata: { from: current.role, to: input.role, sessionsRevoked: sessions.count } } }); return { blocked: false as const, user };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  if (result.blocked) throw lastAdminError(); return result.user;
}

export async function deactivateUser(targetUserId: string, input: DeactivateInput, actorId: string) {
  const result = await prisma.$transaction(async tx => {
    const current = await tx.user.findUnique({ where: { id: targetUserId }, select: { role: true, active: true, approvedAt: true } });
    if (!current) throw new UserManagementError('USER_NOT_FOUND', 'Usuário não encontrado.', 404);
    if (!current.active) return { blocked: false as const, user: await tx.user.findUniqueOrThrow({ where: { id: targetUserId }, select: userSelect }) };
    if (current.role === 'ADMIN' && current.approvedAt && await isLastAdministrator(tx, targetUserId)) { await tx.adminAudit.create({ data: { type: 'LAST_ADMIN_BLOCKED', actorId, targetUserId, metadata: { action: 'deactivate' } } }); return { blocked: true as const }; }
    const cases = await tx.sacRecord.findMany({ where: { assigneeId: targetUserId, archivedAt: null, status: { in: ['PENDING', 'IN_PROGRESS'] } }, select: { id: true, ticket: true } });
    if (cases.length && !input.strategy) throw new UserManagementError('CASE_DESTINATION_REQUIRED', 'Escolha o destino dos casos abertos antes de inativar.', 422);
    let recipient: { id: string; name: string } | null = null;
    if (cases.length && input.strategy === 'transfer') {
      if (!input.transferToUserId || input.transferToUserId === targetUserId) throw new UserManagementError('INVALID_TRANSFER_TARGET', 'Selecione outro responsável elegível.', 422);
      recipient = await tx.user.findFirst({ where: { id: input.transferToUserId, active: true, approvedAt: { not: null }, rejectedAt: null, role: { in: ['ADMIN', 'ANALYST'] } }, select: { id: true, name: true } });
      if (!recipient) throw new UserManagementError('INVALID_TRANSFER_TARGET', 'Selecione outro responsável elegível.', 422);
    }
    if (cases.length && input.strategy === 'unassigned' && !input.confirmUnassigned) throw new UserManagementError('UNASSIGN_CONFIRMATION_REQUIRED', 'Confirme que os casos ficarão sem responsável.', 422);
    const activityAt = new Date();
    for (const record of cases) {
      await tx.sacRecord.update({ where: { id: record.id }, data: { assigneeId: recipient?.id ?? null, lastOperationalActivityAt: activityAt } });
      await tx.activityLog.create({ data: { recordId: record.id, actorId, eventType: 'CASE_TRANSFERRED', summary: recipient ? `Caso transferido para ${recipient.name} por inativação do responsável.` : 'Caso ficou sem responsável por inativação do responsável.', before: { assigneeId: targetUserId }, after: { assigneeId: recipient?.id ?? null }, createdAt: activityAt } });
      if (recipient) await createCaseNotification(tx, { recipientId: recipient.id, actorId, recordId: record.id, ticket: record.ticket, type: 'ASSIGNEE_CHANGED', title: 'Caso transferido para você', summary: `${record.ticket} foi transferido para sua responsabilidade.`, metadata: { ticket: record.ticket } });
    }
    const user = await tx.user.update({ where: { id: targetUserId }, data: { active: false, tokenVersion: { increment: 1 } }, select: userSelect });
    const sessions = await revokeSessions(tx, targetUserId, activityAt);
    await tx.adminAudit.create({ data: { type: 'USER_DEACTIVATED', actorId, targetUserId, justification: input.justification, metadata: { openCaseCount: cases.length, strategy: input.strategy ?? 'none', transferToUserId: recipient?.id ?? null, sessionsRevoked: sessions.count } } });
    if (cases.length) await tx.adminAudit.create({ data: { type: 'CASES_TRANSFERRED', actorId, targetUserId, metadata: { count: cases.length, strategy: input.strategy, transferToUserId: recipient?.id ?? null } } });
    return { blocked: false as const, user };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  if (result.blocked) throw lastAdminError(); return result.user;
}

export async function reactivateUser(targetUserId: string, reason: string, actorId: string) {
  return prisma.$transaction(async tx => {
    const current = await tx.user.findUnique({ where: { id: targetUserId }, select: { active: true, approvedAt: true, rejectedAt: true } });
    if (!current) throw new UserManagementError('USER_NOT_FOUND', 'Usuário não encontrado.', 404);
    if (!current.approvedAt || current.rejectedAt) throw new UserManagementError('USER_NOT_APPROVED', 'Somente contas aprovadas podem ser reativadas.', 422);
    if (current.active) return tx.user.findUniqueOrThrow({ where: { id: targetUserId }, select: userSelect });
    const user = await tx.user.update({ where: { id: targetUserId }, data: { active: true, tokenVersion: { increment: 1 } }, select: userSelect });
    const sessions = await revokeSessions(tx, targetUserId);
    await tx.adminAudit.create({ data: { type: 'USER_REACTIVATED', actorId, targetUserId, justification: reason, metadata: { sessionsRevoked: sessions.count } } }); return user;
  });
}

export async function listUserAudits(targetUserId: string) { return prisma.adminAudit.findMany({ where: { targetUserId }, select: { id: true, type: true, justification: true, metadata: true, createdAt: true, actor: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' }, take: 50 }); }
