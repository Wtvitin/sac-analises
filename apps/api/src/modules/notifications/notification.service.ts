import { NotificationType, Prisma } from '@prisma/client';
import type { z } from 'zod';
import { civilDayNumber, classifyOperationalAttention } from '../../domain/operational-attention.js';
import { prisma } from '../../lib/prisma.js';
import type { notificationListSchema } from './notification.schema.js';

type ListInput = z.infer<typeof notificationListSchema>;
type Transaction = Prisma.TransactionClient;

export class NotificationError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) { super(message); }
}

export type CaseNotificationInput = {
  recipientId: string | null;
  actorId: string;
  recordId: string;
  ticket: string;
  type: NotificationType;
  title: string;
  summary: string;
  metadata?: Prisma.InputJsonValue;
};

/** Creates an action notification inside the caller's case transaction. */
export async function createCaseNotification(tx: Transaction, input: CaseNotificationInput) {
  if (!input.recipientId || input.recipientId === input.actorId) return null;
  return tx.notification.create({ data: {
    recipientId: input.recipientId, recordId: input.recordId, type: input.type,
    title: input.title, summary: input.summary, metadata: input.metadata,
  } });
}

function notificationWhere(recipientId: string, filter?: string, role?: string, department?: string | null): Prisma.NotificationWhereInput {
  const base: Prisma.NotificationWhereInput = {
    recipientId,
    ...(filter === 'unread' ? { readAt: null } : {}),
    OR: [
      { recordId: null },
      { record: { archivedAt: null } },
    ],
  };
  if (role === 'ADMIN' || !role || department === undefined) return base;
  if (!department) {
    return {
      ...base,
      recordId: null,
    };
  }
  return {
    recipientId,
    ...(filter === 'unread' ? { readAt: null } : {}),
    OR: [
      { recordId: null },
      { record: { department, archivedAt: null } },
    ],
  };
}

export async function listNotifications(recipientId: string, input: ListInput, role?: string, department?: string | null) {
  const where = notificationWhere(recipientId, input.filter, role, department);
  const [items, total] = await prisma.$transaction([
    prisma.notification.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (input.page - 1) * input.pageSize, take: input.pageSize, include: { record: { select: { id: true, ticket: true, department: true, archivedAt: true } } } }),
    prisma.notification.count({ where }),
  ]);
  return { items, total, page: input.page, pageSize: input.pageSize };
}

export async function unreadNotificationCount(recipientId: string, role?: string, department?: string | null) {
  const where = notificationWhere(recipientId, 'unread', role, department);
  return { count: await prisma.notification.count({ where }) };
}

export async function getNotification(recipientId: string, id: string, role?: string, department?: string | null) {
  const where: Prisma.NotificationWhereInput = {
    id,
    ...notificationWhere(recipientId, undefined, role, department),
  };
  const notification = await prisma.notification.findFirst({ where, include: { record: { select: { id: true, ticket: true, department: true, archivedAt: true } } } });
  if (!notification) throw new NotificationError('NOTIFICATION_NOT_FOUND', 'Notificação não encontrada.', 404);
  return notification;
}

export async function markNotificationRead(recipientId: string, id: string, roleOrNow?: string | Date, department?: string | null, nowArg?: Date) {
  let role: string | undefined;
  let now: Date;
  if (roleOrNow instanceof Date) {
    role = undefined;
    now = roleOrNow;
  } else {
    role = roleOrNow;
    now = nowArg ?? new Date();
  }
  const where = { id, ...notificationWhere(recipientId, 'unread', role, department) };
  const changed = await prisma.notification.updateMany({ where, data: { readAt: now } });
  if (!changed.count) {
    const existing = await prisma.notification.findFirst({ where: { id, ...notificationWhere(recipientId, undefined, role, department) }, select: { id: true } });
    if (!existing) throw new NotificationError('NOTIFICATION_NOT_FOUND', 'Notificação não encontrada.', 404);
  }
  return getNotification(recipientId, id, role, department);
}

export async function markAllNotificationsRead(recipientId: string, roleOrNow?: string | Date, department?: string | null, nowArg?: Date) {
  let role: string | undefined;
  let now: Date;
  if (roleOrNow instanceof Date) {
    role = undefined;
    now = roleOrNow;
  } else {
    role = roleOrNow;
    now = nowArg ?? new Date();
  }
  const where = notificationWhere(recipientId, 'unread', role, department);
  const result = await prisma.notification.updateMany({ where, data: { readAt: now } });
  return { updated: result.count };
}

type TemporalCandidate = {
  id: string; ticket: string; status: 'PENDING' | 'IN_PROGRESS'; priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  dueAt: Date; assigneeId: string | null; lastOperationalActivityAt: Date; openedAt: Date;
};

function temporalNotification(record: TemporalCandidate, recipientId: string, type: NotificationType, title: string, summary: string, state: string, now: Date): Prisma.NotificationCreateManyInput {
  return { recipientId, recordId: record.id, type, title, summary, createdAt: now,
    metadata: { ticket: record.ticket, state }, dedupeKey: `temporal:${record.id}:${recipientId}:${type}:${state}` };
}

function temporalEntries(record: TemporalCandidate, administratorIds: string[], now: Date) {
  const flags = classifyOperationalAttention(record, now); const stateDue = String(civilDayNumber(record.dueAt));
  const entries: Prisma.NotificationCreateManyInput[] = [];
  if (record.assigneeId && flags.isNearDue) entries.push(temporalNotification(record, record.assigneeId, 'NEAR_DUE', 'Caso próximo do prazo', `${record.ticket} vence em breve.`, stateDue, now));
  if (record.assigneeId && flags.isDueToday) entries.push(temporalNotification(record, record.assigneeId, 'DUE_TODAY', 'Caso vencendo hoje', `${record.ticket} vence hoje.`, stateDue, now));
  if (record.assigneeId && flags.isOverdue) entries.push(temporalNotification(record, record.assigneeId, 'OVERDUE', 'Caso atrasado', `${record.ticket} está atrasado e requer atenção.`, stateDue, now));
  if (record.assigneeId && flags.isStale) entries.push(temporalNotification(record, record.assigneeId, 'STALE', 'Caso sem atualização', `${record.ticket} está sem atividade operacional recente.`, String(record.lastOperationalActivityAt.getTime()), now));
  if (!record.assigneeId) for (const administratorId of administratorIds) entries.push(temporalNotification(record, administratorId, 'UNASSIGNED', 'Caso sem responsável', `${record.ticket} ainda não possui responsável.`, String(record.lastOperationalActivityAt.getTime()), now));
  return entries;
}

/** Idempotent policy: one notice per case, recipient, condition and relevant state. */
export async function generateTemporalNotifications(now = new Date()) {
  return prisma.$transaction(async tx => {
    const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>(Prisma.sql`SELECT pg_try_advisory_xact_lock(734221, 6) AS acquired`);
    if (!lock?.acquired) return { acquired: false, created: 0 };
    const administrators = await tx.user.findMany({ where: { role: 'ADMIN', active: true, approvedAt: { not: null } }, select: { id: true } });
    let cursor: string | undefined; let created = 0;
    do {
      const records = await tx.sacRecord.findMany({
        where: { archivedAt: null, status: { in: ['PENDING', 'IN_PROGRESS'] } },
        select: { id: true, ticket: true, status: true, priority: true, dueAt: true, assigneeId: true, lastOperationalActivityAt: true, openedAt: true },
        orderBy: { id: 'asc' }, take: 200, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!records.length) break;
      const data = records.flatMap(record => temporalEntries(record as TemporalCandidate, administrators.map(user => user.id), now));
      if (data.length) created += (await tx.notification.createMany({ data, skipDuplicates: true })).count;
      cursor = records.at(-1)!.id;
      if (records.length < 200) break;
    } while (cursor);
    return { acquired: true, created };
  });
}
