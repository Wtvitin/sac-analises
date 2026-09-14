import { Prisma } from '@prisma/client';
import type { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { MAX_ATTACHMENT_COUNT, type StoredAttachment } from '../../lib/attachment-storage.js';
import { assertCanCancel, assertCanComplete, assertCanReactivate, assertCanReopen, assertStatusTransition } from '../../domain/sac-rules.js';
import { classifyOperationalAttention, operationalBoundaries } from '../../domain/operational-attention.js';
import { normalizeCatalogName } from '../catalog/catalog.schema.js';
import { createCaseNotification } from '../notifications/notification.service.js';
import type { assignmentSchema, changeStatusSchema, commentSchema, createSacRecordSchema, dueDateChangeSchema, historyQuerySchema, listSacRecordsSchema, priorityChangeSchema, takeCaseSchema, updateSacRecordSchema } from './sac.schema.js';

type ListInput = z.infer<typeof listSacRecordsSchema>;
type CreateInput = z.infer<typeof createSacRecordSchema>;
type UpdateInput = z.infer<typeof updateSacRecordSchema>;
type ChangeStatusInput = z.infer<typeof changeStatusSchema>;
type AssignmentInput = z.infer<typeof assignmentSchema>;
type TakeInput = z.infer<typeof takeCaseSchema>;
type PriorityInput = z.infer<typeof priorityChangeSchema>;
type DueDateInput = z.infer<typeof dueDateChangeSchema>;
type CommentInput = z.infer<typeof commentSchema>;
type HistoryInput = z.infer<typeof historyQuerySchema>;
type ExistingReferences = { reasonId: string; subreasonId: string | null; channelId: string | null; assigneeId: string | null };

export class SacRecordError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) { super(message); }
}

const recordInclude = {
  customer: true,
  reason: true,
  subreason: true,
  channelCatalog: true,
  assignee: { select: { id: true, name: true, active: true } },
  items: { orderBy: { createdAt: 'asc' as const } },
  attachments: { orderBy: { createdAt: 'asc' as const } },
  comments: { orderBy: { createdAt: 'desc' as const }, take: 20, include: { author: { select: { id: true, name: true } } } },
  activities: { orderBy: { createdAt: 'desc' as const }, take: 20, include: { actor: { select: { id: true, name: true } } } },
} satisfies Prisma.SacRecordInclude;

function errorCode(error: unknown) { return error && typeof error === 'object' && 'code' in error ? String(error.code) : ''; }
function serializeDate(value: Date) { return value.toISOString(); }

async function validateReferences(tx: Prisma.TransactionClient, input: CreateInput | UpdateInput, current?: ExistingReferences) {
  const [reason, channel, subreason, assignee] = await Promise.all([
    tx.reason.findUnique({ where: { id: input.reasonId }, select: { id: true, name: true, active: true } }),
    tx.channel.findUnique({ where: { id: input.channelId }, select: { id: true, name: true, active: true } }),
    input.subreasonId ? tx.subreason.findUnique({ where: { id: input.subreasonId }, select: { id: true, reasonId: true, active: true } }) : null,
    input.assigneeId ? tx.user.findUnique({ where: { id: input.assigneeId }, select: { id: true, name: true, active: true, approvedAt: true, role: true } }) : null,
  ]);
  if (!reason || (!reason.active && reason.id !== current?.reasonId)) throw new SacRecordError('INACTIVE_REASON', 'Selecione um motivo ativo.', 422);
  if (!channel || (!channel.active && channel.id !== current?.channelId)) throw new SacRecordError('INACTIVE_CHANNEL', 'Selecione um canal ativo.', 422);
  if (input.subreasonId && (!subreason || subreason.reasonId !== reason.id || (!subreason.active && subreason.id !== current?.subreasonId))) throw new SacRecordError('INVALID_SUBREASON', 'Selecione um submotivo ativo pertencente ao motivo informado.', 422);
  if (input.assigneeId && (!assignee || (!assignee.active && assignee.id !== current?.assigneeId) || !assignee.approvedAt || !['ADMIN', 'ANALYST'].includes(assignee.role))) throw new SacRecordError('INVALID_ASSIGNEE', 'Selecione um responsável disponível.', 422);
  return { reason, channel, assignee };
}

async function assertExternalTicketDecision(tx: Prisma.TransactionClient, externalTicket: string | null, allowDuplicate: boolean, excludeId?: string) {
  if (!externalTicket || allowDuplicate) return;
  const matches = await tx.sacRecord.count({ where: { externalTicket: { equals: externalTicket, mode: 'insensitive' }, ...(excludeId ? { id: { not: excludeId } } : {}) } });
  if (matches) throw new SacRecordError('EXTERNAL_TICKET_DUPLICATE', 'Já existe um caso com este protocolo externo. Confirme se deseja continuar mesmo assim.', 409);
}

function attentionWhere(input: ListInput['attention'], now: Date): Prisma.SacRecordWhereInput | undefined {
  if (!input) return undefined;
  const { todayStart, tomorrowStart, nearDueEnd, staleBefore } = operationalBoundaries(now);
  const open: Prisma.SacRecordWhereInput = { status: { in: ['PENDING', 'IN_PROGRESS'] } };
  const variants: Record<NonNullable<ListInput['attention']>, Prisma.SacRecordWhereInput> = {
    overdue: { ...open, dueAt: { lt: todayStart } },
    dueToday: { ...open, dueAt: { gte: todayStart, lt: tomorrowStart } },
    nearDue: { ...open, dueAt: { gte: tomorrowStart, lt: nearDueEnd } },
    stale: { ...open, lastOperationalActivityAt: { lte: staleBefore } },
    unassigned: { ...open, assigneeId: null },
    noDue: { id: '__MODEL_REQUIRES_DUE_DATE__' },
    required: { ...open, OR: [
      { dueAt: { lt: nearDueEnd } }, { priority: { in: ['HIGH', 'CRITICAL'] } }, { assigneeId: null }, { lastOperationalActivityAt: { lte: staleBefore } },
    ] },
  };
  return variants[input];
}

function attentionSql(input: ListInput, now: Date) {
  const { todayStart, tomorrowStart, nearDueEnd, staleBefore } = operationalBoundaries(now);
  const clauses: Prisma.Sql[] = [Prisma.sql`s."archivedAt" IS NULL`];
  if (input.status) clauses.push(Prisma.sql`s."status"::text = ${input.status}`);
  if (input.priority) clauses.push(Prisma.sql`s."priority"::text = ${input.priority}`);
  if (input.owner) clauses.push(Prisma.sql`u."name" = ${input.owner}`);
  if (input.unassigned) clauses.push(Prisma.sql`s."assigneeId" IS NULL`);
  if (input.reason) clauses.push(Prisma.sql`r."name" = ${input.reason}`);
  if (input.openedFrom) clauses.push(Prisma.sql`s."openedAt" >= ${new Date(input.openedFrom)}`);
  if (input.openedTo) clauses.push(Prisma.sql`s."openedAt" < ${new Date(input.openedTo)}`);
  if (input.dueFrom) clauses.push(Prisma.sql`s."dueAt" >= ${new Date(input.dueFrom)}`);
  if (input.dueTo) clauses.push(Prisma.sql`s."dueAt" < ${new Date(input.dueTo)}`);
  if (input.overdueBefore) clauses.push(Prisma.sql`s."status"::text IN ('PENDING', 'IN_PROGRESS') AND s."dueAt" < ${new Date(input.overdueBefore)}`);
  const open = Prisma.sql`s."status"::text IN ('PENDING', 'IN_PROGRESS')`;
  const attentionClauses: Record<NonNullable<ListInput['attention']>, Prisma.Sql> = {
    overdue: Prisma.sql`${open} AND s."dueAt" < ${todayStart}`,
    dueToday: Prisma.sql`${open} AND s."dueAt" >= ${todayStart} AND s."dueAt" < ${tomorrowStart}`,
    nearDue: Prisma.sql`${open} AND s."dueAt" >= ${tomorrowStart} AND s."dueAt" < ${nearDueEnd}`,
    stale: Prisma.sql`${open} AND s."lastOperationalActivityAt" <= ${staleBefore}`,
    unassigned: Prisma.sql`${open} AND s."assigneeId" IS NULL`,
    noDue: Prisma.sql`FALSE`,
    required: Prisma.sql`${open} AND (s."dueAt" < ${nearDueEnd} OR s."priority"::text IN ('HIGH', 'CRITICAL') OR s."assigneeId" IS NULL OR s."lastOperationalActivityAt" <= ${staleBefore})`,
  };
  if (input.attention) clauses.push(attentionClauses[input.attention]);
  if (input.query) {
    const query = `%${input.query}%`;
    clauses.push(Prisma.sql`(s."ticket" ILIKE ${query} OR s."externalTicket" ILIKE ${query} OR s."orderNumber" ILIKE ${query} OR c."name" ILIKE ${query} OR r."name" ILIKE ${query})`);
  }
  return { clauses, todayStart, tomorrowStart, nearDueEnd, staleBefore };
}

async function attentionPageIds(input: ListInput, now: Date) {
  const { clauses, todayStart, tomorrowStart, nearDueEnd, staleBefore } = attentionSql(input, now);
  const offset = (input.page - 1) * input.pageSize;
  return prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT s."id"
    FROM "SacRecord" s
    JOIN "Customer" c ON c."id" = s."customerId"
    JOIN "Reason" r ON r."id" = s."reasonId"
    LEFT JOIN "User" u ON u."id" = s."assigneeId"
    WHERE ${Prisma.join(clauses, ' AND ')}
    ORDER BY
      CASE WHEN s."status"::text IN ('PENDING', 'IN_PROGRESS') AND s."dueAt" < ${todayStart} THEN 0 ELSE 1 END,
      CASE WHEN s."status"::text IN ('PENDING', 'IN_PROGRESS') AND s."dueAt" >= ${todayStart} AND s."dueAt" < ${tomorrowStart} THEN 0 ELSE 1 END,
      CASE WHEN s."status"::text IN ('PENDING', 'IN_PROGRESS') AND s."dueAt" >= ${tomorrowStart} AND s."dueAt" < ${nearDueEnd} THEN 0 ELSE 1 END,
      CASE WHEN s."status"::text IN ('PENDING', 'IN_PROGRESS') AND s."priority"::text IN ('HIGH', 'CRITICAL') THEN 0 ELSE 1 END,
      CASE WHEN s."status"::text IN ('PENDING', 'IN_PROGRESS') AND s."assigneeId" IS NULL THEN 0 ELSE 1 END,
      CASE WHEN s."status"::text IN ('PENDING', 'IN_PROGRESS') AND s."lastOperationalActivityAt" <= ${staleBefore} THEN 0 ELSE 1 END,
      s."dueAt" ASC NULLS LAST, s."openedAt" ASC, s."id" ASC
    LIMIT ${input.pageSize} OFFSET ${offset}
  `);
}

export async function listSacRecords(input: ListInput, now = new Date()) {
  const attention = attentionWhere(input.attention, now);
  const conditions: Prisma.SacRecordWhereInput[] = [];
  if (attention) conditions.push(attention);
  if (input.overdueBefore) conditions.push({ status: { in: ['PENDING', 'IN_PROGRESS'] }, dueAt: { lt: input.overdueBefore } });
  const where: Prisma.SacRecordWhereInput = {
    archivedAt: null,
    status: input.status,
    priority: input.priority,
    ...(input.owner ? { assignee: { name: input.owner } } : {}),
    ...(input.unassigned ? { assigneeId: null } : {}),
    ...(input.reason ? { reason: { name: input.reason } } : {}),
    ...(input.openedFrom || input.openedTo ? { openedAt: { gte: input.openedFrom, lt: input.openedTo } } : {}),
    ...(input.dueFrom || input.dueTo ? { dueAt: { gte: input.dueFrom, lt: input.dueTo } } : {}),
    ...(conditions.length ? { AND: conditions } : {}),
    ...(input.query ? { OR: [
      { ticket: { contains: input.query, mode: 'insensitive' } },
      { externalTicket: { contains: input.query, mode: 'insensitive' } },
      { orderNumber: { contains: input.query, mode: 'insensitive' } },
      { customer: { name: { contains: input.query, mode: 'insensitive' } } },
      { reason: { name: { contains: input.query, mode: 'insensitive' } } },
    ] } : {}),
  };
  const boundaries = operationalBoundaries(now);
  const openWhere: Prisma.SacRecordWhereInput = { archivedAt: null, status: { in: ['PENDING', 'IN_PROGRESS'] } };
  const attentionIds = input.sort === 'attention' ? await attentionPageIds(input, now) : null;
  const findWhere = attentionIds ? { id: { in: attentionIds.map(row => row.id) } } : where;
  const findTake = input.sort === 'attention' ? undefined : input.pageSize;
  const findSkip = input.sort === 'attention' ? undefined : (input.page - 1) * input.pageSize;
  const orderBy: Prisma.SacRecordOrderByWithRelationInput[] = input.sort === 'attention'
    ? [{ dueAt: 'asc' }, { priority: 'desc' }, { openedAt: 'asc' }, { id: 'asc' }]
    : [input.sort === 'customer' ? { customer: { name: input.order } } : { [input.sort]: input.order }, { id: 'asc' }];
  const [foundItems, total, owners, reasons, statusCounts, overdue, dueToday, nearDue, stale, unassigned, attentionTotal] = await prisma.$transaction([
    prisma.sacRecord.findMany({ where: findWhere, skip: findSkip, take: findTake, orderBy, include: { customer: true, reason: true, subreason: true, assignee: { select: { id: true, name: true } } } }),
    prisma.sacRecord.count({ where }),
    prisma.user.findMany({ where: { assignedCases: { some: { archivedAt: null } } }, select: { name: true }, orderBy: { name: 'asc' } }),
    prisma.reason.findMany({ select: { name: true }, orderBy: { name: 'asc' } }),
    prisma.sacRecord.groupBy({ by: ['status'], where: { archivedAt: null }, _count: true, orderBy: { status: 'asc' } }),
    prisma.sacRecord.count({ where: { ...openWhere, dueAt: { lt: boundaries.todayStart } } }),
    prisma.sacRecord.count({ where: { ...openWhere, dueAt: { gte: boundaries.todayStart, lt: boundaries.tomorrowStart } } }),
    prisma.sacRecord.count({ where: { ...openWhere, dueAt: { gte: boundaries.tomorrowStart, lt: boundaries.nearDueEnd } } }),
    prisma.sacRecord.count({ where: { ...openWhere, lastOperationalActivityAt: { lte: boundaries.staleBefore } } }),
    prisma.sacRecord.count({ where: { ...openWhere, assigneeId: null } }),
    prisma.sacRecord.count({ where: { ...openWhere, OR: [{ dueAt: { lt: boundaries.nearDueEnd } }, { priority: { in: ['HIGH', 'CRITICAL'] } }, { assigneeId: null }, { lastOperationalActivityAt: { lte: boundaries.staleBefore } }] } }),
  ]);
  const orderedItems = attentionIds ? [...foundItems].sort((left, right) => attentionIds.findIndex(row => row.id === left.id) - attentionIds.findIndex(row => row.id === right.id)) : foundItems;
  const items = orderedItems
    .map(record => ({ ...record, operational: classifyOperationalAttention(record, now) }));
  return { items, page: input.page, pageSize: input.pageSize, total, serverNow: now, operationalConfig: { timezone: 'America/Sao_Paulo', nearDueDays: 2, staleAfterDays: 3 }, options: { owners: [...new Set(owners.map(owner => owner.name))], reasons: reasons.map(reason => reason.name) }, counts: { ...Object.fromEntries(statusCounts.map(group => [group.status, group._count])), overdue, dueToday, nearDue, stale, unassigned, noDue: 0, attention: attentionTotal } };
}

export async function getSacRecord(recordId: string) {
  const record = await prisma.sacRecord.findFirst({ where: { id: recordId, archivedAt: null }, include: recordInclude });
  if (!record) throw new SacRecordError('SAC_RECORD_NOT_FOUND', 'Registro não encontrado.', 404);
  return { ...record, operational: classifyOperationalAttention(record) };
}

export async function checkExternalTicket(value: string, excludeId?: string) {
  const count = await prisma.sacRecord.count({ where: { archivedAt: null, externalTicket: { equals: value, mode: 'insensitive' }, ...(excludeId ? { id: { not: excludeId } } : {}) } });
  return { duplicate: count > 0 };
}

export async function searchCustomers(query: string) {
  return prisma.customer.findMany({
    where: { archivedAt: null, ...(query ? { name: { contains: query, mode: 'insensitive' } } : {}) },
    select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 10,
  });
}

export async function createSacRecord(input: CreateInput, actorId: string, idempotencyKey: string, attachments: StoredAttachment[] = []) {
  const existing = await prisma.sacRecord.findUnique({ where: { idempotencyKey }, include: recordInclude });
  if (existing) return { record: { ...existing, operational: classifyOperationalAttention(existing) }, created: false };
  try {
    return await prisma.$transaction(async tx => {
      const replay = await tx.sacRecord.findUnique({ where: { idempotencyKey }, include: recordInclude });
      if (replay) return { record: { ...replay, operational: classifyOperationalAttention(replay) }, created: false };
      const { reason, channel, assignee } = await validateReferences(tx, input);
      await assertExternalTicketDecision(tx, input.externalTicket, input.allowDuplicateExternalTicket);
      const customer = await tx.customer.upsert({ where: { normalizedName: normalizeCatalogName(input.customerName) }, update: {}, create: { name: input.customerName, normalizedName: normalizeCatalogName(input.customerName) } });
      const year = input.openedAt.getUTCFullYear();
      const counter = await tx.ticketCounter.upsert({ where: { year }, create: { year, value: 1 }, update: { value: { increment: 1 } } });
      const ticket = `SAC-${year}-${String(counter.value).padStart(4, '0')}`;
      const activityAt = new Date();
      const created = await tx.sacRecord.create({
        data: {
          ticket, idempotencyKey, orderNumber: input.orderNumber, externalTicket: input.externalTicket,
          description: input.description, internalNote: input.internalNote, identifiedCause: input.identifiedCause,
          responsibleArea: input.responsibleArea, correctiveAction: input.correctiveAction, priority: input.priority,
          channel: channel.name, channelId: channel.id, openedAt: input.openedAt, dueAt: input.dueAt,
          customerId: customer.id, reasonId: reason.id, subreasonId: input.subreasonId, assigneeId: input.assigneeId, createdById: actorId, lastOperationalActivityAt: activityAt,
          items: { create: input.items.map(item => ({ code: item.code, description: item.description, batch: item.batch, quantity: item.quantity, note: item.note })) },
          attachments: { create: attachments },
        },
      });
      await tx.activityLog.create({ data: { recordId: created.id, actorId, eventType: 'CREATED', summary: `Registro ${ticket} criado. Responsável: ${assignee?.name ?? 'Sem responsável'}. Status inicial: PENDING.`, createdAt: activityAt } });
      await createCaseNotification(tx, { recipientId: input.assigneeId, actorId, recordId: created.id, ticket, type: 'ASSIGNED', title: 'Caso atribuído a você', summary: `${ticket} foi atribuído à sua responsabilidade.`, metadata: { ticket } });
      const record = await tx.sacRecord.findUniqueOrThrow({ where: { id: created.id }, include: recordInclude });
      return { record: { ...record, operational: classifyOperationalAttention(record) }, created: true };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (errorCode(error) === 'P2002') {
      const replay = await prisma.sacRecord.findUnique({ where: { idempotencyKey }, include: recordInclude });
      if (replay) return { record: { ...replay, operational: classifyOperationalAttention(replay) }, created: false };
    }
    throw error;
  }
}

export async function updateSacRecord(recordId: string, input: UpdateInput, actorId: string, attachments: StoredAttachment[] = []) {
  return prisma.$transaction(async tx => {
    const current = await tx.sacRecord.findFirst({ where: { id: recordId, archivedAt: null }, include: { items: true, _count: { select: { attachments: true } } } });
    if (!current) throw new SacRecordError('SAC_RECORD_NOT_FOUND', 'Registro não encontrado.', 404);
    if (current.updatedAt.getTime() !== input.updatedAt.getTime()) throw new SacRecordError('STALE_SAC_RECORD', 'Este registro foi atualizado por outro usuário. Recarregue os dados antes de salvar novamente.', 409);
    if (current._count.attachments + attachments.length > MAX_ATTACHMENT_COUNT) throw new SacRecordError('TOO_MANY_ATTACHMENTS', `Mantenha no máximo ${MAX_ATTACHMENT_COUNT} evidências por registro.`, 422);
    const references = await validateReferences(tx, input, current);
    await assertExternalTicketDecision(tx, input.externalTicket, input.allowDuplicateExternalTicket, recordId);
    const customer = await tx.customer.upsert({ where: { normalizedName: normalizeCatalogName(input.customerName) }, update: {}, create: { name: input.customerName, normalizedName: normalizeCatalogName(input.customerName) } });
    const activityAt = new Date();
    const updated = await tx.sacRecord.updateMany({
      where: { id: recordId, updatedAt: input.updatedAt },
      data: {
        orderNumber: input.orderNumber, externalTicket: input.externalTicket, description: input.description, internalNote: input.internalNote,
        identifiedCause: input.identifiedCause, responsibleArea: input.responsibleArea, correctiveAction: input.correctiveAction,
        channel: references.channel.name, channelId: input.channelId, openedAt: input.openedAt,
        customerId: customer.id, reasonId: input.reasonId, subreasonId: input.subreasonId, lastOperationalActivityAt: activityAt,
      },
    });
    if (updated.count !== 1) throw new SacRecordError('STALE_SAC_RECORD', 'Este registro foi atualizado por outro usuário. Recarregue os dados antes de salvar novamente.', 409);
    await tx.sacItem.deleteMany({ where: { recordId } });
    if (input.items.length) await tx.sacItem.createMany({ data: input.items.map(item => ({ recordId, code: item.code, description: item.description, batch: item.batch, quantity: item.quantity, note: item.note })) });
    if (attachments.length) await tx.attachment.createMany({ data: attachments.map(file => ({ ...file, recordId })) });
    await tx.activityLog.create({
      data: {
        recordId, actorId, eventType: 'UPDATED', summary: 'Dados do registro atualizados.',
        before: { orderNumber: current.orderNumber, externalTicket: current.externalTicket, itemCount: current.items.length },
        after: { orderNumber: input.orderNumber, externalTicket: input.externalTicket, itemCount: input.items.length, attachmentCountAdded: attachments.length }, createdAt: activityAt,
      },
    });
    const record = await tx.sacRecord.findUniqueOrThrow({ where: { id: recordId }, include: recordInclude });
    return { ...record, operational: classifyOperationalAttention(record) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function currentForOperation(tx: Prisma.TransactionClient, recordId: string, updatedAt: Date) {
  const current = await tx.sacRecord.findFirst({ where: { id: recordId, archivedAt: null } });
  if (!current) throw new SacRecordError('SAC_RECORD_NOT_FOUND', 'Registro não encontrado.', 404);
  if (current.updatedAt.getTime() !== updatedAt.getTime()) throw new SacRecordError('STALE_SAC_RECORD', 'Este caso foi atualizado por outro usuário. Recarregue as informações antes de continuar.', 409);
  return current;
}

async function finishOperation(tx: Prisma.TransactionClient, recordId: string) {
  const record = await tx.sacRecord.findUniqueOrThrow({ where: { id: recordId }, include: recordInclude });
  return { ...record, operational: classifyOperationalAttention(record) };
}

async function operationalUser(tx: Prisma.TransactionClient, userId: string) {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, name: true, active: true, approvedAt: true, role: true } });
  if (!user || !user.active || !user.approvedAt || !['ADMIN', 'ANALYST'].includes(user.role)) throw new SacRecordError('INVALID_ASSIGNEE', 'Selecione um responsável ativo, aprovado e com permissão operacional.', 422);
  return user;
}

function assertOperationalState(status: string) {
  if (status === 'COMPLETED' || status === 'CANCELLED') throw new SacRecordError('CASE_NOT_OPERATIONAL', 'Reabra ou reative o caso antes de alterar seus dados operacionais.', 422);
}

export async function assignSacRecord(recordId: string, input: AssignmentInput, actorId: string) {
  return prisma.$transaction(async tx => {
    const current = await currentForOperation(tx, recordId, input.updatedAt);
    assertOperationalState(current.status);
    const next = input.assigneeId ? await operationalUser(tx, input.assigneeId) : null;
    if (current.assigneeId === input.assigneeId) throw new SacRecordError('ASSIGNEE_UNCHANGED', 'O responsável informado já está atribuído ao caso.', 422);
    const previous = current.assigneeId ? await tx.user.findUnique({ where: { id: current.assigneeId }, select: { name: true } }) : null;
    const activityAt = new Date();
    const changed = await tx.sacRecord.updateMany({ where: { id: recordId, updatedAt: input.updatedAt }, data: { assigneeId: input.assigneeId, lastOperationalActivityAt: activityAt } });
    if (changed.count !== 1) throw new SacRecordError('STALE_SAC_RECORD', 'Este caso foi atualizado por outro usuário. Recarregue as informações antes de continuar.', 409);
    const eventType = input.assigneeId ? (current.assigneeId ? 'ASSIGNEE_CHANGED' : 'ASSIGNED') : 'ASSIGNEE_REMOVED';
    await tx.activityLog.create({ data: { recordId, actorId, eventType, summary: input.assigneeId ? `Responsável alterado para ${next!.name}.` : 'Responsável removido.', before: { assigneeId: current.assigneeId, assigneeName: previous?.name ?? null }, after: { assigneeId: input.assigneeId, assigneeName: next?.name ?? null, justification: input.justification }, createdAt: activityAt } });
    await createCaseNotification(tx, { recipientId: input.assigneeId, actorId, recordId, ticket: current.ticket, type: current.assigneeId ? 'ASSIGNEE_CHANGED' : 'ASSIGNED', title: current.assigneeId ? 'Responsabilidade alterada' : 'Caso atribuído a você', summary: `${current.ticket} está agora sob sua responsabilidade.`, metadata: { ticket: current.ticket, previousAssigneeId: current.assigneeId } });
    return finishOperation(tx, recordId);
  });
}

export async function takeSacRecord(recordId: string, input: TakeInput, actorId: string) {
  return prisma.$transaction(async tx => {
    const current = await currentForOperation(tx, recordId, input.updatedAt); const actor = await operationalUser(tx, actorId);
    assertOperationalState(current.status);
    if (current.assigneeId) throw new SacRecordError('CASE_ALREADY_ASSIGNED', 'O caso já possui responsável.', 409);
    const activityAt = new Date();
    const changed = await tx.sacRecord.updateMany({ where: { id: recordId, updatedAt: input.updatedAt }, data: { assigneeId: actorId, lastOperationalActivityAt: activityAt } });
    if (changed.count !== 1) throw new SacRecordError('STALE_SAC_RECORD', 'Este caso foi atualizado por outro usuário. Recarregue as informações antes de continuar.', 409);
    await tx.activityLog.create({ data: { recordId, actorId, eventType: 'CASE_TAKEN', summary: `${actor.name} assumiu o caso.`, before: { assigneeId: null }, after: { assigneeId: actorId, assigneeName: actor.name }, createdAt: activityAt } });
    return finishOperation(tx, recordId);
  });
}

const priorityRank = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 } as const;
export async function changeSacPriority(recordId: string, input: PriorityInput, actorId: string) {
  return prisma.$transaction(async tx => {
    const current = await currentForOperation(tx, recordId, input.updatedAt);
    assertOperationalState(current.status);
    if (current.priority === input.priority) throw new SacRecordError('PRIORITY_UNCHANGED', 'Selecione uma prioridade diferente.', 422);
    if (priorityRank[input.priority] < priorityRank[current.priority] && !input.justification?.trim()) throw new SacRecordError('JUSTIFICATION_REQUIRED', 'Informe a justificativa para reduzir a prioridade.', 422);
    const activityAt = new Date();
    const changed = await tx.sacRecord.updateMany({ where: { id: recordId, updatedAt: input.updatedAt }, data: { priority: input.priority, lastOperationalActivityAt: activityAt } });
    if (changed.count !== 1) throw new SacRecordError('STALE_SAC_RECORD', 'Este caso foi atualizado por outro usuário. Recarregue as informações antes de continuar.', 409);
    await tx.activityLog.create({ data: { recordId, actorId, eventType: 'PRIORITY_CHANGED', summary: `Prioridade alterada de ${current.priority} para ${input.priority}.`, before: { priority: current.priority }, after: { priority: input.priority, justification: input.justification }, createdAt: activityAt } });
    if (priorityRank[input.priority] > priorityRank[current.priority]) await createCaseNotification(tx, { recipientId: current.assigneeId, actorId, recordId, ticket: current.ticket, type: 'PRIORITY_RAISED', title: 'Prioridade elevada', summary: `${current.ticket} teve a prioridade elevada para ${input.priority}.`, metadata: { ticket: current.ticket, priority: input.priority } });
    return finishOperation(tx, recordId);
  });
}

export async function changeSacDueDate(recordId: string, input: DueDateInput, actorId: string) {
  return prisma.$transaction(async tx => {
    const current = await currentForOperation(tx, recordId, input.updatedAt);
    assertOperationalState(current.status);
    if (input.dueAt < current.openedAt) throw new SacRecordError('INVALID_DUE_DATE', 'O prazo não pode ser anterior à abertura.', 422);
    if (input.dueAt.getTime() === current.dueAt.getTime()) throw new SacRecordError('DUE_DATE_UNCHANGED', 'Informe um prazo diferente.', 422);
    if (input.dueAt > current.dueAt && !input.justification?.trim()) throw new SacRecordError('JUSTIFICATION_REQUIRED', 'Informe a justificativa para prorrogar o prazo.', 422);
    const activityAt = new Date();
    const changed = await tx.sacRecord.updateMany({ where: { id: recordId, updatedAt: input.updatedAt }, data: { dueAt: input.dueAt, lastOperationalActivityAt: activityAt } });
    if (changed.count !== 1) throw new SacRecordError('STALE_SAC_RECORD', 'Este caso foi atualizado por outro usuário. Recarregue as informações antes de continuar.', 409);
    await tx.activityLog.create({ data: { recordId, actorId, eventType: 'DUE_DATE_CHANGED', summary: `Prazo alterado para ${serializeDate(input.dueAt)}.`, before: { dueAt: serializeDate(current.dueAt) }, after: { dueAt: serializeDate(input.dueAt), justification: input.justification, overdue: input.dueAt < activityAt }, createdAt: activityAt } });
    await createCaseNotification(tx, { recipientId: current.assigneeId, actorId, recordId, ticket: current.ticket, type: 'DUE_DATE_CHANGED', title: 'Prazo alterado', summary: `O prazo de ${current.ticket} foi alterado.`, metadata: { ticket: current.ticket, dueAt: serializeDate(input.dueAt) } });
    return finishOperation(tx, recordId);
  });
}

export function sanitizeComment(value: string) { return value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim(); }
export async function addSacComment(recordId: string, input: CommentInput, actorId: string) {
  const body = sanitizeComment(input.body);
  if (!body) throw new SacRecordError('EMPTY_COMMENT', 'Escreva um comentário.', 422);
  return prisma.$transaction(async tx => {
    const current = await currentForOperation(tx, recordId, input.updatedAt);
    const comment = await tx.comment.create({ data: { recordId, authorId: actorId, body }, include: { author: { select: { id: true, name: true } } } });
    const activityAt = new Date();
    const changed = await tx.sacRecord.updateMany({ where: { id: recordId, updatedAt: input.updatedAt }, data: { updatedAt: activityAt, lastOperationalActivityAt: activityAt } });
    if (changed.count !== 1) throw new SacRecordError('STALE_SAC_RECORD', 'Este caso foi atualizado por outro usuário. Recarregue as informações antes de continuar.', 409);
    await tx.activityLog.create({ data: { recordId, actorId, eventType: 'COMMENT_ADDED', summary: 'Comentário interno adicionado.', after: { commentId: comment.id }, createdAt: activityAt } });
    await createCaseNotification(tx, { recipientId: current.assigneeId, actorId, recordId, ticket: current.ticket, type: 'COMMENT_ADDED', title: 'Novo comentário no caso', summary: `${current.ticket} recebeu um comentário interno.`, metadata: { ticket: current.ticket, commentId: comment.id } });
    return { comment, record: await finishOperation(tx, recordId) };
  });
}

export async function getSacHistory(recordId: string, input: HistoryInput) {
  const where = { recordId, record: { archivedAt: null } };
  const [items, total] = await prisma.$transaction([
    prisma.activityLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (input.page - 1) * input.pageSize, take: input.pageSize, include: { actor: { select: { id: true, name: true } } } }),
    prisma.activityLog.count({ where }),
  ]);
  return { items, total, page: input.page, pageSize: input.pageSize };
}

export async function changeSacStatus(recordId: string, input: ChangeStatusInput, actorId: string, actorRole: 'ADMIN' | 'ANALYST') {
  return prisma.$transaction(async tx => {
    const current = await currentForOperation(tx, recordId, input.updatedAt);
    try { assertStatusTransition(current.status, input.status, actorRole); }
    catch (error) { const message = (error as Error).message; throw new SacRecordError('INVALID_STATUS_TRANSITION', message, message.includes('Somente administradores') ? 403 : 422); }
    if (input.status === 'COMPLETED') {
      try { assertCanComplete(input.solutionSummary); } catch (error) { throw new SacRecordError('COMPLETION_INCOMPLETE', (error as Error).message, 422); }
      if (!input.identifiedCause?.trim() || !input.responsibleArea?.trim() || !input.correctiveAction?.trim()) throw new SacRecordError('COMPLETION_INCOMPLETE', 'Informe causa, área responsável e ação corretiva.', 422);
    }
    if (current.status === 'COMPLETED') { try { assertCanReopen(input.reason); } catch (error) { throw new SacRecordError('JUSTIFICATION_REQUIRED', (error as Error).message, 422); } }
    if (input.status === 'CANCELLED') { try { assertCanCancel(input.reason); } catch (error) { throw new SacRecordError('JUSTIFICATION_REQUIRED', (error as Error).message, 422); } }
    if (current.status === 'CANCELLED') { try { assertCanReactivate(input.reason); } catch (error) { throw new SacRecordError('JUSTIFICATION_REQUIRED', (error as Error).message, 422); } }
    let assumedBy: { id: string; name: string } | null = null;
    if (input.assumeIfUnassigned && !current.assigneeId) assumedBy = await operationalUser(tx, actorId);
    if (current.status === 'PENDING' && input.status === 'IN_PROGRESS' && !current.assigneeId && !assumedBy) throw new SacRecordError('ASSIGNEE_REQUIRED', 'Atribua um responsável ou assuma o caso antes de iniciar o atendimento.', 422);
    const eventType = input.status === 'COMPLETED' ? 'COMPLETED' : input.status === 'CANCELLED' ? 'CANCELLED' : current.status === 'COMPLETED' ? 'REOPENED' : current.status === 'CANCELLED' ? 'REACTIVATED' : 'SERVICE_STARTED';
    const activityAt = new Date();
    const changed = await tx.sacRecord.updateMany({ where: { id: recordId, updatedAt: input.updatedAt }, data: {
      status: input.status, assigneeId: assumedBy?.id ?? current.assigneeId,
      solutionSummary: input.status === 'COMPLETED' ? input.solutionSummary : current.solutionSummary,
      identifiedCause: input.status === 'COMPLETED' ? input.identifiedCause : current.identifiedCause,
      responsibleArea: input.status === 'COMPLETED' ? input.responsibleArea : current.responsibleArea,
      correctiveAction: input.status === 'COMPLETED' ? input.correctiveAction : current.correctiveAction,
      reopenedReason: current.status === 'COMPLETED' ? input.reason : current.reopenedReason,
      cancellationReason: input.status === 'CANCELLED' ? input.reason : current.cancellationReason,
      completedAt: input.status === 'COMPLETED' ? activityAt : current.completedAt, lastOperationalActivityAt: activityAt,
    } });
    if (changed.count !== 1) throw new SacRecordError('STALE_SAC_RECORD', 'Este caso foi atualizado por outro usuário. Recarregue as informações antes de continuar.', 409);
    await tx.activityLog.create({ data: { recordId, actorId, eventType, summary: `Status alterado de ${current.status} para ${input.status}.`, before: { status: current.status, assigneeId: current.assigneeId }, after: { status: input.status, reason: input.reason, assumedBy: assumedBy?.name, solutionSummary: input.solutionSummary, identifiedCause: input.identifiedCause, responsibleArea: input.responsibleArea, correctiveAction: input.correctiveAction }, createdAt: activityAt } });
    const notificationType = eventType === 'REOPENED' ? 'REOPENED' : eventType === 'CANCELLED' ? 'CANCELLED' : eventType === 'COMPLETED' ? 'COMPLETED' : 'STATUS_CHANGED';
    const notificationTitle = eventType === 'REOPENED' ? 'Caso reaberto' : eventType === 'CANCELLED' ? 'Caso cancelado' : eventType === 'COMPLETED' ? 'Caso concluído' : 'Status alterado';
    await createCaseNotification(tx, { recipientId: assumedBy?.id ?? current.assigneeId, actorId, recordId, ticket: current.ticket, type: notificationType, title: notificationTitle, summary: `${current.ticket} teve o status alterado para ${input.status}.`, metadata: { ticket: current.ticket, status: input.status } });
    return finishOperation(tx, recordId);
  });
}
