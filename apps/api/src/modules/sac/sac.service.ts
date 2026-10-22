import { Prisma } from '@prisma/client';
import type { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { MAX_ATTACHMENT_COUNT, type StoredAttachment } from '../../lib/attachment-storage.js';
import { assertCanCancel, assertCanComplete, assertCanReactivate, assertCanReopen, assertStatusTransition } from '../../domain/sac-rules.js';
import { classifyOperationalAttention, operationalBoundaries } from '../../domain/operational-attention.js';
import { normalizeCatalogName } from '../catalog/catalog.schema.js';
import { createCaseNotification } from '../notifications/notification.service.js';
import { confirmDocumentImport } from '../document-imports/document-import.service.js';
import { logSensitiveDataRevealAudit, maskCpfCnpj, type SensitiveCategory } from '../../lib/privacy/privacy.service.js';
import { listSacRecordsSchema } from './sac.schema.js';
import type { assignmentSchema, changeStatusSchema, commentSchema, createSacRecordSchema, deleteSacRecordSchema, dueDateChangeSchema, historyQuerySchema, priorityChangeSchema, takeCaseSchema, transferDepartmentSchema, updateSacRecordSchema, updateTreatmentSchema } from './sac.schema.js';

type ListInput = z.input<typeof listSacRecordsSchema>;
type ListParsedInput = z.infer<typeof listSacRecordsSchema>;
type CreateInput = z.infer<typeof createSacRecordSchema>;
type UpdateInput = z.infer<typeof updateSacRecordSchema>;
type ChangeStatusInput = z.infer<typeof changeStatusSchema>;
type AssignmentInput = z.infer<typeof assignmentSchema>;
type TakeInput = z.infer<typeof takeCaseSchema>;
type PriorityInput = z.infer<typeof priorityChangeSchema>;
type DueDateInput = z.infer<typeof dueDateChangeSchema>;
type CommentInput = z.infer<typeof commentSchema>;
type HistoryInput = z.infer<typeof historyQuerySchema>;
type TransferDepartmentInput = z.infer<typeof transferDepartmentSchema>;
type DeleteSacRecordInput = z.infer<typeof deleteSacRecordSchema>;
type ExistingReferences = { reasonId: string; subreasonId: string | null; channelId: string | null; assigneeId: string | null };

export class SacRecordError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) { super(message); }
}

const recordInclude = {
  customer: true,
  reason: true,
  subreason: true,
  channelCatalog: true,
  assignee: { select: { id: true, name: true, active: true, role: true, department: true } },
  references: { orderBy: { createdAt: 'asc' as const } },
  items: { orderBy: { createdAt: 'asc' as const } },
  attachments: {
    orderBy: { createdAt: 'asc' as const },
    include: { author: { select: { id: true, name: true } } },
  },
  comments: { orderBy: { createdAt: 'desc' as const }, take: 20, include: { author: { select: { id: true, name: true } } } },
  activities: { orderBy: { createdAt: 'desc' as const }, take: 20, include: { actor: { select: { id: true, name: true } } } },
} satisfies Prisma.SacRecordInclude;

export type MaskedCustomerRecord<T> = T extends { customer: infer C }
  ? Omit<T, 'customer'> & { customer: C extends object ? C & { isDocumentMasked?: boolean } : C }
  : T;

export function maskRecordSensitiveData<T extends { customer?: { document?: string | null; [key: string]: any } | null }>(
  record: T
): MaskedCustomerRecord<T> {
  if (!record || !record.customer || !record.customer.document) return record as MaskedCustomerRecord<T>;
  return {
    ...record,
    customer: {
      ...record.customer,
      document: maskCpfCnpj(record.customer.document),
      isDocumentMasked: true,
    },
  } as MaskedCustomerRecord<T>;
}

function errorCode(error: unknown) { return error && typeof error === 'object' && 'code' in error ? String(error.code) : ''; }
function serializeDate(value: Date) { return value.toISOString(); }

async function validateReferences(tx: Prisma.TransactionClient, input: CreateInput | UpdateInput, current?: ExistingReferences, caseDepartment?: string | null) {
  const [reason, channel, subreason, assignee] = await Promise.all([
    tx.reason.findUnique({ where: { id: input.reasonId }, select: { id: true, name: true, active: true } }),
    tx.channel.findUnique({ where: { id: input.channelId }, select: { id: true, name: true, active: true } }),
    input.subreasonId ? tx.subreason.findUnique({ where: { id: input.subreasonId }, select: { id: true, reasonId: true, active: true } }) : null,
    input.assigneeId ? tx.user.findUnique({ where: { id: input.assigneeId }, select: { id: true, name: true, active: true, approvedAt: true, role: true, department: true } }) : null,
  ]);
  if (!reason || (!reason.active && reason.id !== current?.reasonId)) throw new SacRecordError('INACTIVE_REASON', 'Selecione um motivo ativo.', 422);
  if (!channel || (!channel.active && channel.id !== current?.channelId)) throw new SacRecordError('INACTIVE_CHANNEL', 'Selecione um canal ativo.', 422);
  if (input.subreasonId && (!subreason || subreason.reasonId !== reason.id || (!subreason.active && subreason.id !== current?.subreasonId))) throw new SacRecordError('INVALID_SUBREASON', 'Selecione um submotivo ativo pertencente ao motivo informado.', 422);
  if (input.assigneeId) {
    if (!assignee || (!assignee.active && assignee.id !== current?.assigneeId) || !assignee.approvedAt || !['ADMIN', 'ANALYST'].includes(assignee.role)) {
      throw new SacRecordError('INVALID_ASSIGNEE', 'Selecione um responsável disponível.', 422);
    }
    if (assignee.role === 'ANALYST' && caseDepartment && assignee.department !== caseDepartment) {
      throw new SacRecordError('ASSIGNEE_DEPARTMENT_MISMATCH', 'O responsável selecionado pertence a outro setor.', 422);
    }
  }
  return { reason, channel, assignee };
}

async function assertExternalTicketDecision(tx: Prisma.TransactionClient, externalTicket: string | null, allowDuplicate: boolean, caseDepartment?: string | null, excludeId?: string, userRole?: string) {
  if (!externalTicket || allowDuplicate) return;
  const where: Prisma.SacRecordWhereInput = {
    externalTicket: { equals: externalTicket, mode: 'insensitive' },
    ...(excludeId ? { id: { not: excludeId } } : {}),
    ...(userRole !== 'ADMIN' && caseDepartment ? { department: caseDepartment } : {}),
  };
  const matches = await tx.sacRecord.count({ where });
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

function attentionSql(input: ListParsedInput, userRole: string, userDepartment: string | null, now: Date) {
  const { todayStart, tomorrowStart, nearDueEnd, staleBefore } = operationalBoundaries(now);
  const clauses: Prisma.Sql[] = [Prisma.sql`s."archivedAt" IS NULL`];
  if (userRole !== 'ADMIN') {
    if (userDepartment) {
      clauses.push(Prisma.sql`s."department" = ${userDepartment}`);
    } else {
      clauses.push(Prisma.sql`1 = 0`);
    }
  } else if (input.department) {
    if (input.department === 'unassigned' || input.department === 'none' || input.department === 'Sem setor definido') {
      clauses.push(Prisma.sql`s."department" IS NULL`);
    } else {
      clauses.push(Prisma.sql`s."department" = ${input.department}`);
    }
  }
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
    clauses.push(Prisma.sql`(s."ticket" ILIKE ${query} OR s."externalTicket" ILIKE ${query} OR s."orderNumber" ILIKE ${query} OR c."name" ILIKE ${query} OR r."name" ILIKE ${query} OR EXISTS (SELECT 1 FROM "SacReference" ref WHERE ref."recordId" = s."id" AND ref."value" ILIKE ${query}))`);
  }
  return { clauses, todayStart, tomorrowStart, nearDueEnd, staleBefore };
}

async function attentionPageIds(input: ListParsedInput, userRole: string, userDepartment: string | null, now: Date) {
  const { clauses, todayStart, tomorrowStart, nearDueEnd, staleBefore } = attentionSql(input, userRole, userDepartment, now);
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

export async function listSacRecords(
  rawInput: ListInput,
  userRoleOrNow?: string | Date,
  userDepartment?: string | null,
  nowArg = new Date(),
) {
  const input = listSacRecordsSchema.parse(rawInput);
  let userRole: string;
  let userDepartmentResolved: string | null;
  let now: Date;
  if (userRoleOrNow instanceof Date) {
    userRole = 'ADMIN';
    userDepartmentResolved = null;
    now = userRoleOrNow;
  } else {
    userRole = userRoleOrNow ?? 'ADMIN';
    userDepartmentResolved = userDepartment ?? null;
    now = nowArg;
  }

  const attention = attentionWhere(input.attention, now);
  const conditions: Prisma.SacRecordWhereInput[] = [];
  if (attention) conditions.push(attention);
  if (input.overdueBefore) conditions.push({ status: { in: ['PENDING', 'IN_PROGRESS'] }, dueAt: { lt: input.overdueBefore } });

  let deptFilter: Prisma.SacRecordWhereInput = {};
  if (userRole !== 'ADMIN') {
    if (userDepartmentResolved) {
      deptFilter = { department: userDepartmentResolved };
    } else {
      deptFilter = { id: '__NONE__' };
    }
  } else if (input.department) {
    if (input.department === 'unassigned' || input.department === 'none' || input.department === 'Sem setor definido') {
      deptFilter = { department: null };
    } else {
      deptFilter = { department: input.department };
    }
  }

  const where: Prisma.SacRecordWhereInput = {
    archivedAt: null,
    ...deptFilter,
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
      { references: { some: { value: { contains: input.query, mode: 'insensitive' } } } },
      { customer: { name: { contains: input.query, mode: 'insensitive' } } },
      { reason: { name: { contains: input.query, mode: 'insensitive' } } },
    ] } : {}),
  };
  const boundaries = operationalBoundaries(now);
  const openWhere: Prisma.SacRecordWhereInput = { archivedAt: null, ...deptFilter, status: { in: ['PENDING', 'IN_PROGRESS'] } };
  const attentionIds = input.sort === 'attention' ? await attentionPageIds(input, userRole, userDepartmentResolved, now) : null;
  const findWhere = attentionIds ? { id: { in: attentionIds.map(row => row.id) } } : where;
  const findTake = input.sort === 'attention' ? undefined : input.pageSize;
  const findSkip = input.sort === 'attention' ? undefined : (input.page - 1) * input.pageSize;
  const orderBy: Prisma.SacRecordOrderByWithRelationInput[] = input.sort === 'attention'
    ? [{ dueAt: 'asc' }, { priority: 'desc' }, { openedAt: 'asc' }, { id: 'asc' }]
    : [input.sort === 'customer' ? { customer: { name: input.order } } : { [input.sort]: input.order }, { id: 'asc' }];
  const [foundItems, total, owners, reasons, statusCounts, overdue, dueToday, nearDue, stale, unassigned, attentionTotal] = await prisma.$transaction([
    prisma.sacRecord.findMany({ where: findWhere, skip: findSkip, take: findTake, orderBy, include: { customer: true, reason: true, subreason: true, references: { orderBy: { createdAt: 'asc' } }, assignee: { select: { id: true, name: true, role: true, department: true } } } }),
    prisma.sacRecord.count({ where }),
    prisma.user.findMany({ where: { assignedCases: { some: { archivedAt: null, ...deptFilter } }, deletedAt: null }, select: { name: true }, orderBy: { name: 'asc' } }),
    prisma.reason.findMany({ select: { name: true }, orderBy: { name: 'asc' } }),
    prisma.sacRecord.groupBy({ by: ['status'], where: { archivedAt: null, ...deptFilter }, _count: true, orderBy: { status: 'asc' } }),
    prisma.sacRecord.count({ where: { ...openWhere, dueAt: { lt: boundaries.todayStart } } }),
    prisma.sacRecord.count({ where: { ...openWhere, dueAt: { gte: boundaries.todayStart, lt: boundaries.tomorrowStart } } }),
    prisma.sacRecord.count({ where: { ...openWhere, dueAt: { gte: boundaries.tomorrowStart, lt: boundaries.nearDueEnd } } }),
    prisma.sacRecord.count({ where: { ...openWhere, lastOperationalActivityAt: { lte: boundaries.staleBefore } } }),
    prisma.sacRecord.count({ where: { ...openWhere, assigneeId: null } }),
    prisma.sacRecord.count({ where: { ...openWhere, OR: [{ dueAt: { lt: boundaries.nearDueEnd } }, { priority: { in: ['HIGH', 'CRITICAL'] } }, { assigneeId: null }, { lastOperationalActivityAt: { lte: boundaries.staleBefore } }] } }),
  ]);
  const orderedItems = attentionIds ? [...foundItems].sort((left, right) => attentionIds.findIndex(row => row.id === left.id) - attentionIds.findIndex(row => row.id === right.id)) : foundItems;
  const items = orderedItems
    .map(record => maskRecordSensitiveData({ ...record, operational: classifyOperationalAttention(record, now) }));
  return { items, page: input.page, pageSize: input.pageSize, total, serverNow: now, operationalConfig: { timezone: 'America/Sao_Paulo', nearDueDays: 2, staleAfterDays: 3 }, options: { owners: [...new Set(owners.map(owner => owner.name))], reasons: reasons.map(reason => reason.name) }, counts: { ...Object.fromEntries(statusCounts.map(group => [group.status, group._count])), overdue, dueToday, nearDue, stale, unassigned, noDue: 0, attention: attentionTotal } };
}

export async function getSacRecord(recordId: string, userRole: string = 'ADMIN', userDepartment?: string | null) {
  const record = await prisma.sacRecord.findFirst({ where: { id: recordId, archivedAt: null }, include: recordInclude });
  if (!record) throw new SacRecordError('SAC_RECORD_NOT_FOUND', 'Registro não encontrado.', 404);
  if (userRole !== 'ADMIN' && userDepartment !== undefined) {
    if (!record.department || record.department !== userDepartment) {
      throw new SacRecordError('SAC_RECORD_NOT_FOUND', 'Registro não encontrado.', 404);
    }
  }
  return maskRecordSensitiveData({ ...record, operational: classifyOperationalAttention(record) });
}

export async function checkExternalTicket(value: string, userRole?: string, userDepartment?: string | null, excludeId?: string) {
  const where: Prisma.SacRecordWhereInput = {
    archivedAt: null,
    externalTicket: { equals: value, mode: 'insensitive' },
    ...(userRole !== 'ADMIN' && userDepartment ? { department: userDepartment } : {}),
    ...(excludeId ? { id: { not: excludeId } } : {}),
  };
  const count = await prisma.sacRecord.count({ where });
  return { duplicate: count > 0 };
}

export async function searchCustomers(query: string, userRole?: string, userDepartment?: string | null) {
  const where: Prisma.CustomerWhereInput = {
    archivedAt: null,
    ...(query ? { name: { contains: query, mode: 'insensitive' } } : {}),
    ...(userRole !== 'ADMIN' && userDepartment ? { records: { some: { department: userDepartment, archivedAt: null } } } : {}),
  };
  return prisma.customer.findMany({
    where,
    select: { id: true, name: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    take: 10,
  });
}

export async function createSacRecord(
  input: CreateInput,
  actorId: string,
  roleOrIdempotencyKey: string = 'ADMIN',
  departmentOrAttachments?: string | null | StoredAttachment[],
  keyOrAttachments?: string | StoredAttachment[],
  maybeAttachments: StoredAttachment[] = [],
) {
  let actorRole: string;
  let actorDepartment: string | null;
  let idempotencyKey: string;
  let attachments: StoredAttachment[];
  const isExplicitRole = roleOrIdempotencyKey === 'ADMIN' || roleOrIdempotencyKey === 'ANALYST' || roleOrIdempotencyKey === 'VIEWER';

  if (isExplicitRole) {
    actorRole = roleOrIdempotencyKey;
    actorDepartment = typeof departmentOrAttachments === 'string' ? departmentOrAttachments : null;
    idempotencyKey = typeof keyOrAttachments === 'string' ? keyOrAttachments : '';
    attachments = maybeAttachments;
  } else {
    // Called as createSacRecord(input, actorId, idempotencyKey, attachments)
    actorRole = 'ADMIN';
    actorDepartment = null;
    idempotencyKey = roleOrIdempotencyKey;
    attachments = Array.isArray(departmentOrAttachments) ? departmentOrAttachments : (Array.isArray(keyOrAttachments) ? keyOrAttachments : []);
  }

  let caseDepartment: string;
  if (actorRole === 'ADMIN') {
    if (!input.department || !input.department.trim()) {
      if (!isExplicitRole) {
        caseDepartment = 'Atendimento';
      } else {
        throw new SacRecordError('DEPARTMENT_REQUIRED', 'Informe o setor do caso.', 422);
      }
    } else {
      caseDepartment = input.department.trim();
    }
  } else {
    if (!actorDepartment) {
      throw new SacRecordError('USER_DEPARTMENT_REQUIRED', 'Seu usuário não possui um setor vinculado. Solicite a vinculação a um administrador.', 422);
    }
    caseDepartment = actorDepartment;
  }

  const existing = await prisma.sacRecord.findUnique({ where: { idempotencyKey }, include: recordInclude });
  if (existing) return { record: maskRecordSensitiveData({ ...existing, operational: classifyOperationalAttention(existing) }), created: false };
  try {
    const result = await prisma.$transaction(async tx => {
      const replay = await tx.sacRecord.findUnique({ where: { idempotencyKey }, include: recordInclude });
      if (replay) return { record: maskRecordSensitiveData({ ...replay, operational: classifyOperationalAttention(replay) }), created: false };
      const { reason, channel, assignee } = await validateReferences(tx, input, undefined, caseDepartment);
      await assertExternalTicketDecision(tx, input.externalTicket, input.allowDuplicateExternalTicket, caseDepartment, undefined, actorRole);
      const customer = await tx.customer.upsert({ where: { normalizedName: normalizeCatalogName(input.customerName) }, update: {}, create: { name: input.customerName, normalizedName: normalizeCatalogName(input.customerName) } });
      const year = input.openedAt.getUTCFullYear();
      const counter = await tx.ticketCounter.upsert({ where: { year }, create: { year, value: 1 }, update: { value: { increment: 1 } } });
      const ticket = `SAC-${year}-${String(counter.value).padStart(4, '0')}`;
      const activityAt = new Date();

      let effectiveOrderNumber = input.orderNumber || null;
      let effectiveExternalTicket = input.externalTicket || null;

      const referencesToCreate: Array<{
        type: 'ORDER' | 'INVOICE' | 'SERVICE_ORDER' | 'PROTOCOL' | 'ATTENDANCE' | 'CUSTOMER_CODE' | 'INTERNAL_DOC' | 'OTHER';
        value: string;
        note: string | null;
      }> = [];
      const seenRefs = new Set<string>();

      if (Array.isArray(input.references)) {
        for (const ref of input.references) {
          if (!ref.value) continue;
          const key = `${ref.type}:${ref.value}`;
          if (!seenRefs.has(key)) {
            seenRefs.add(key);
            referencesToCreate.push({ type: ref.type, value: ref.value, note: ref.note ?? null });
          }
          if (ref.type === 'ORDER' && !effectiveOrderNumber) {
            effectiveOrderNumber = ref.value;
          }
          if ((ref.type === 'ATTENDANCE' || ref.type === 'PROTOCOL') && !effectiveExternalTicket) {
            effectiveExternalTicket = ref.value;
          }
        }
      }

      if (effectiveOrderNumber && !seenRefs.has(`ORDER:${effectiveOrderNumber}`)) {
        seenRefs.add(`ORDER:${effectiveOrderNumber}`);
        referencesToCreate.push({ type: 'ORDER', value: effectiveOrderNumber, note: null });
      }

      if (effectiveExternalTicket && !seenRefs.has(`ATTENDANCE:${effectiveExternalTicket}`) && !seenRefs.has(`PROTOCOL:${effectiveExternalTicket}`)) {
        seenRefs.add(`ATTENDANCE:${effectiveExternalTicket}`);
        referencesToCreate.push({ type: 'ATTENDANCE', value: effectiveExternalTicket, note: null });
      }

      const created = await tx.sacRecord.create({
        data: {
          ticket, idempotencyKey, department: caseDepartment, orderNumber: effectiveOrderNumber, externalTicket: effectiveExternalTicket,
          description: input.description, internalNote: input.internalNote, identifiedCause: input.identifiedCause,
          responsibleArea: input.responsibleArea, correctiveAction: input.correctiveAction, priority: input.priority,
          channel: channel.name, channelId: channel.id, openedAt: input.openedAt, dueAt: input.dueAt,
          customerId: customer.id, reasonId: reason.id, subreasonId: input.subreasonId, assigneeId: input.assigneeId, createdById: actorId, lastOperationalActivityAt: activityAt,
          references: referencesToCreate.length ? {
            create: referencesToCreate.map(r => ({ type: r.type, value: r.value, note: r.note })),
          } : undefined,
          items: { create: input.items.map(item => ({ code: item.code, description: item.description, batch: item.batch, quantity: item.quantity, note: item.note })) },
          attachments: {
            create: attachments.map(att => ({
              originalName: att.originalName,
              mimeType: att.mimeType,
              sizeBytes: att.sizeBytes,
              storageKey: att.storageKey,
              sha256: att.sha256 ?? '',
              storageProvider: att.storageProvider ?? 'local',
              authorId: att.authorId ?? actorId,
            })),
          },
        },
      });
      await tx.activityLog.create({
        data: {
          recordId: created.id,
          actorId,
          eventType: 'CREATED',
          summary: `Registro ${ticket} criado no setor ${caseDepartment}.${input.importSessionId ? ' Criado a partir de formulário importado.' : ''} Responsável: ${assignee?.name ?? 'Sem responsável'}. Status inicial: PENDING.`,
          createdAt: activityAt,
        },
      });
      await createCaseNotification(tx, { recipientId: input.assigneeId, actorId, recordId: created.id, ticket, type: 'ASSIGNED', title: 'Caso atribuído a você', summary: `${ticket} foi atribuído à sua responsabilidade.`, metadata: { ticket } });
      const record = await tx.sacRecord.findUniqueOrThrow({ where: { id: created.id }, include: recordInclude });
      return { record: maskRecordSensitiveData({ ...record, operational: classifyOperationalAttention(record) }), created: true };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    if (result.created && input.importSessionId) {
      await confirmDocumentImport(input.importSessionId, result.record.id, Boolean(input.preserveImportAsAttachment), actorId);
      const reloaded = await prisma.sacRecord.findUnique({ where: { id: result.record.id }, include: recordInclude });
      if (reloaded) {
        return { record: maskRecordSensitiveData({ ...reloaded, operational: classifyOperationalAttention(reloaded) }), created: true };
      }
    }

    return result;
  } catch (error) {
    if (errorCode(error) === 'P2002') {
      const replay = await prisma.sacRecord.findUnique({ where: { idempotencyKey }, include: recordInclude });
      if (replay) return { record: maskRecordSensitiveData({ ...replay, operational: classifyOperationalAttention(replay) }), created: false };
    }
    throw error;
  }
}

export async function updateSacRecord(
  recordId: string,
  input: UpdateInput,
  actorId: string,
  actorRoleOrAttachments?: string | StoredAttachment[],
  actorDepartment?: string | null,
  maybeAttachments: StoredAttachment[] = [],
) {
  let actorRole: string;
  let actorDept: string | null;
  let attachments: StoredAttachment[];

  if (Array.isArray(actorRoleOrAttachments)) {
    actorRole = 'ADMIN';
    actorDept = null;
    attachments = actorRoleOrAttachments;
  } else {
    actorRole = actorRoleOrAttachments ?? 'ADMIN';
    actorDept = actorDepartment ?? null;
    attachments = maybeAttachments;
  }

  return prisma.$transaction(async tx => {
    const current = await tx.sacRecord.findFirst({ where: { id: recordId, archivedAt: null }, include: { items: true, _count: { select: { attachments: true } } } });
    if (!current) throw new SacRecordError('SAC_RECORD_NOT_FOUND', 'Registro não encontrado.', 404);
    if (actorRole !== 'ADMIN' && actorDept !== undefined) {
      if (!current.department || current.department !== actorDept) {
        throw new SacRecordError('SAC_RECORD_NOT_FOUND', 'Registro não encontrado.', 404);
      }
    }
    if (current.updatedAt.getTime() !== input.updatedAt.getTime()) throw new SacRecordError('STALE_SAC_RECORD', 'Este registro foi atualizado por outro usuário. Recarregue os dados antes de salvar novamente.', 409);
    if (current._count.attachments + attachments.length > MAX_ATTACHMENT_COUNT) throw new SacRecordError('TOO_MANY_ATTACHMENTS', `Mantenha no máximo ${MAX_ATTACHMENT_COUNT} evidências por registro.`, 422);
    const references = await validateReferences(tx, input, current, current.department);
    await assertExternalTicketDecision(tx, input.externalTicket, input.allowDuplicateExternalTicket, current.department, recordId, actorRole);
    const customer = await tx.customer.upsert({ where: { normalizedName: normalizeCatalogName(input.customerName) }, update: {}, create: { name: input.customerName, normalizedName: normalizeCatalogName(input.customerName) } });
    const activityAt = new Date();

    let effectiveOrderNumber = input.orderNumber || null;
    let effectiveExternalTicket = input.externalTicket || null;

    const referencesToCreate: Array<{
      type: 'ORDER' | 'INVOICE' | 'SERVICE_ORDER' | 'PROTOCOL' | 'ATTENDANCE' | 'CUSTOMER_CODE' | 'INTERNAL_DOC' | 'OTHER';
      value: string;
      note: string | null;
    }> = [];
    const seenRefs = new Set<string>();

    if (Array.isArray(input.references)) {
      for (const ref of input.references) {
        if (!ref.value) continue;
        const key = `${ref.type}:${ref.value}`;
        if (!seenRefs.has(key)) {
          seenRefs.add(key);
          referencesToCreate.push({ type: ref.type, value: ref.value, note: ref.note ?? null });
        }
        if (ref.type === 'ORDER' && !effectiveOrderNumber) {
          effectiveOrderNumber = ref.value;
        }
        if ((ref.type === 'ATTENDANCE' || ref.type === 'PROTOCOL') && !effectiveExternalTicket) {
          effectiveExternalTicket = ref.value;
        }
      }
    }

    if (effectiveOrderNumber && !seenRefs.has(`ORDER:${effectiveOrderNumber}`)) {
      seenRefs.add(`ORDER:${effectiveOrderNumber}`);
      referencesToCreate.push({ type: 'ORDER', value: effectiveOrderNumber, note: null });
    }

    if (effectiveExternalTicket && !seenRefs.has(`ATTENDANCE:${effectiveExternalTicket}`) && !seenRefs.has(`PROTOCOL:${effectiveExternalTicket}`)) {
      seenRefs.add(`ATTENDANCE:${effectiveExternalTicket}`);
      referencesToCreate.push({ type: 'ATTENDANCE', value: effectiveExternalTicket, note: null });
    }

    const updated = await tx.sacRecord.updateMany({
      where: { id: recordId, updatedAt: input.updatedAt },
      data: {
        orderNumber: effectiveOrderNumber, externalTicket: effectiveExternalTicket, description: input.description, internalNote: input.internalNote,
        identifiedCause: input.identifiedCause, responsibleArea: input.responsibleArea, correctiveAction: input.correctiveAction,
        channel: references.channel.name, channelId: input.channelId, openedAt: input.openedAt,
        customerId: customer.id, reasonId: input.reasonId, subreasonId: input.subreasonId, lastOperationalActivityAt: activityAt,
      },
    });
    if (updated.count !== 1) throw new SacRecordError('STALE_SAC_RECORD', 'Este registro foi atualizado por outro usuário. Recarregue os dados antes de salvar novamente.', 409);
    await tx.sacItem.deleteMany({ where: { recordId } });
    if (input.items.length) await tx.sacItem.createMany({ data: input.items.map(item => ({ recordId, code: item.code, description: item.description, batch: item.batch, quantity: item.quantity, note: item.note })) });
    await tx.sacReference.deleteMany({ where: { recordId } });
    if (referencesToCreate.length) {
      await tx.sacReference.createMany({
        data: referencesToCreate.map(r => ({ recordId, type: r.type, value: r.value, note: r.note })),
      });
    }
    if (attachments.length) {
      await tx.attachment.createMany({
        data: attachments.map(file => ({
          originalName: file.originalName,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          storageKey: file.storageKey,
          sha256: file.sha256 ?? '',
          storageProvider: file.storageProvider ?? 'local',
          authorId: file.authorId ?? actorId,
          recordId,
        })),
      });
    }
    await tx.activityLog.create({
      data: {
        recordId, actorId, eventType: 'UPDATED', summary: 'Dados do registro atualizados.',
        before: { orderNumber: current.orderNumber, externalTicket: current.externalTicket, itemCount: current.items.length },
        after: { orderNumber: effectiveOrderNumber, externalTicket: effectiveExternalTicket, itemCount: input.items.length, attachmentCountAdded: attachments.length }, createdAt: activityAt,
      },
    });
    const record = await tx.sacRecord.findUniqueOrThrow({ where: { id: recordId }, include: recordInclude });
    return maskRecordSensitiveData({ ...record, operational: classifyOperationalAttention(record) });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function currentForOperation(tx: Prisma.TransactionClient, recordId: string, updatedAt: Date, actorRole?: string, actorDepartment?: string | null) {
  const current = await tx.sacRecord.findFirst({ where: { id: recordId, archivedAt: null }, include: { assignee: true } });
  if (!current) throw new SacRecordError('SAC_RECORD_NOT_FOUND', 'Registro não encontrado.', 404);
  if (actorRole && actorRole !== 'ADMIN' && actorDepartment !== undefined) {
    if (!current.department || current.department !== actorDepartment) {
      throw new SacRecordError('SAC_RECORD_NOT_FOUND', 'Registro não encontrado.', 404);
    }
  }
  if (current.updatedAt.getTime() !== updatedAt.getTime()) throw new SacRecordError('STALE_SAC_RECORD', 'Este caso foi atualizado por outro usuário. Recarregue as informações antes de continuar.', 409);
  return current;
}

async function finishOperation(tx: Prisma.TransactionClient, recordId: string) {
  const record = await tx.sacRecord.findUniqueOrThrow({ where: { id: recordId }, include: recordInclude });
  return { ...record, operational: classifyOperationalAttention(record) };
}

async function operationalUser(tx: Prisma.TransactionClient, userId: string, expectedDepartment?: string | null) {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, name: true, active: true, approvedAt: true, role: true, department: true } });
  if (!user || !user.active || !user.approvedAt || !['ADMIN', 'ANALYST'].includes(user.role)) throw new SacRecordError('INVALID_ASSIGNEE', 'Selecione um responsável ativo, aprovado e com permissão operacional.', 422);
  if (user.role === 'ANALYST' && expectedDepartment && user.department !== expectedDepartment) {
    throw new SacRecordError('ASSIGNEE_DEPARTMENT_MISMATCH', 'O responsável selecionado pertence a outro setor.', 422);
  }
  return user;
}

function assertOperationalState(status: string) {
  if (status === 'COMPLETED' || status === 'CANCELLED') throw new SacRecordError('CASE_NOT_OPERATIONAL', 'Reabra ou reative o caso antes de alterar seus dados operacionais.', 422);
}

export async function assignSacRecord(recordId: string, input: AssignmentInput, actorId: string, actorRole: string = 'ADMIN', actorDepartment?: string | null) {
  return prisma.$transaction(async tx => {
    const current = await currentForOperation(tx, recordId, input.updatedAt, actorRole, actorDepartment);
    assertOperationalState(current.status);
    const next = input.assigneeId ? await operationalUser(tx, input.assigneeId, current.department) : null;
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

export async function takeSacRecord(recordId: string, input: TakeInput, actorId: string, actorRole: string = 'ADMIN', actorDepartment?: string | null) {
  return prisma.$transaction(async tx => {
    const current = await currentForOperation(tx, recordId, input.updatedAt, actorRole, actorDepartment);
    const actor = await operationalUser(tx, actorId, current.department);
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
export async function changeSacPriority(recordId: string, input: PriorityInput, actorId: string, actorRole: string = 'ADMIN', actorDepartment?: string | null) {
  return prisma.$transaction(async tx => {
    const current = await currentForOperation(tx, recordId, input.updatedAt, actorRole, actorDepartment);
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

export async function changeSacDueDate(recordId: string, input: DueDateInput, actorId: string, actorRole: string = 'ADMIN', actorDepartment?: string | null) {
  return prisma.$transaction(async tx => {
    const current = await currentForOperation(tx, recordId, input.updatedAt, actorRole, actorDepartment);
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
export async function addSacComment(recordId: string, input: CommentInput, actorId: string, actorRole: string = 'ADMIN', actorDepartment?: string | null) {
  const body = sanitizeComment(input.body);
  if (!body) throw new SacRecordError('EMPTY_COMMENT', 'Escreva um comentário.', 422);
  return prisma.$transaction(async tx => {
    const current = await currentForOperation(tx, recordId, input.updatedAt, actorRole, actorDepartment);
    const comment = await tx.comment.create({ data: { recordId, authorId: actorId, body }, include: { author: { select: { id: true, name: true } } } });
    const activityAt = new Date();
    const changed = await tx.sacRecord.updateMany({ where: { id: recordId, updatedAt: input.updatedAt }, data: { updatedAt: activityAt, lastOperationalActivityAt: activityAt } });
    if (changed.count !== 1) throw new SacRecordError('STALE_SAC_RECORD', 'Este caso foi atualizado por outro usuário. Recarregue as informações antes de continuar.', 409);
    await tx.activityLog.create({ data: { recordId, actorId, eventType: 'COMMENT_ADDED', summary: 'Comentário interno adicionado.', after: { commentId: comment.id }, createdAt: activityAt } });
    await createCaseNotification(tx, { recipientId: current.assigneeId, actorId, recordId, ticket: current.ticket, type: 'COMMENT_ADDED', title: 'Novo comentário no caso', summary: `${current.ticket} recebeu um comentário interno.`, metadata: { ticket: current.ticket, commentId: comment.id } });
    return { comment, record: await finishOperation(tx, recordId) };
  });
}

export async function getSacHistory(recordId: string, input: HistoryInput, userRole: string = 'ADMIN', userDepartment?: string | null) {
  const record = await prisma.sacRecord.findFirst({
    where: {
      id: recordId,
      ...(userRole === 'ADMIN' ? {} : { archivedAt: null }),
    },
    select: { department: true, archivedAt: true },
  });
  if (!record) throw new SacRecordError('SAC_RECORD_NOT_FOUND', 'Registro não encontrado.', 404);
  if (userRole !== 'ADMIN' && userDepartment !== undefined) {
    if (!record.department || record.department !== userDepartment) {
      throw new SacRecordError('SAC_RECORD_NOT_FOUND', 'Registro não encontrado.', 404);
    }
  }
  const where = {
    recordId,
    ...(userRole === 'ADMIN' ? {} : { record: { archivedAt: null } }),
  };
  const [items, total] = await Promise.all([
    prisma.activityLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (input.page - 1) * input.pageSize, take: input.pageSize, include: { actor: { select: { id: true, name: true } } } }),
    prisma.activityLog.count({ where }),
  ]);
  return { items, total, page: input.page, pageSize: input.pageSize };
}

export async function changeSacStatus(recordId: string, input: ChangeStatusInput, actorId: string, actorRole: 'ADMIN' | 'ANALYST' = 'ADMIN', actorDepartment?: string | null) {
  return prisma.$transaction(async tx => {
    const current = await currentForOperation(tx, recordId, input.updatedAt, actorRole, actorDepartment);
    try { assertStatusTransition(current.status, input.status, actorRole); }
    catch (error) { const message = (error as Error).message; throw new SacRecordError('INVALID_STATUS_TRANSITION', message, message.includes('Somente administradores') ? 403 : 422); }
    if (input.status === 'COMPLETED') {
      const effectiveSolution = input.solutionSummary !== undefined && input.solutionSummary !== null && input.solutionSummary.trim() !== ''
        ? input.solutionSummary.trim()
        : current.solutionSummary;

      try {
        assertCanComplete(effectiveSolution ?? undefined);
      } catch (error) {
        throw new SacRecordError('COMPLETION_INCOMPLETE', (error as Error).message, 422);
      }
    }
    if (current.status === 'COMPLETED') { try { assertCanReopen(input.reason); } catch (error) { throw new SacRecordError('JUSTIFICATION_REQUIRED', (error as Error).message, 422); } }
    if (input.status === 'CANCELLED') { try { assertCanCancel(input.reason); } catch (error) { throw new SacRecordError('JUSTIFICATION_REQUIRED', (error as Error).message, 422); } }
    if (current.status === 'CANCELLED') { try { assertCanReactivate(input.reason); } catch (error) { throw new SacRecordError('JUSTIFICATION_REQUIRED', (error as Error).message, 422); } }
    let assumedBy: { id: string; name: string } | null = null;
    if (input.assumeIfUnassigned && !current.assigneeId) assumedBy = await operationalUser(tx, actorId, current.department);
    if (current.status === 'PENDING' && input.status === 'IN_PROGRESS' && !current.assigneeId && !assumedBy) throw new SacRecordError('ASSIGNEE_REQUIRED', 'Atribua um responsável ou assuma o caso antes de iniciar o atendimento.', 422);
    const eventType = input.status === 'COMPLETED' ? 'COMPLETED' : input.status === 'CANCELLED' ? 'CANCELLED' : current.status === 'COMPLETED' ? 'REOPENED' : current.status === 'CANCELLED' ? 'REACTIVATED' : 'SERVICE_STARTED';
    const activityAt = new Date();

    const effectiveSolution = input.status === 'COMPLETED'
      ? (input.solutionSummary !== undefined && input.solutionSummary !== null && input.solutionSummary.trim() !== '' ? input.solutionSummary.trim() : current.solutionSummary)
      : current.solutionSummary;
    const effectiveCause = input.status === 'COMPLETED'
      ? (input.identifiedCause !== undefined && input.identifiedCause !== null && input.identifiedCause.trim() !== '' ? input.identifiedCause.trim() : current.identifiedCause)
      : current.identifiedCause;
    const effectiveArea = input.status === 'COMPLETED'
      ? (input.responsibleArea !== undefined && input.responsibleArea !== null && input.responsibleArea.trim() !== '' ? input.responsibleArea.trim() : current.responsibleArea)
      : current.responsibleArea;
    const effectiveAction = input.status === 'COMPLETED'
      ? (input.correctiveAction !== undefined && input.correctiveAction !== null && input.correctiveAction.trim() !== '' ? input.correctiveAction.trim() : current.correctiveAction)
      : current.correctiveAction;

    const changed = await tx.sacRecord.updateMany({ where: { id: recordId, updatedAt: input.updatedAt }, data: {
      status: input.status, assigneeId: assumedBy?.id ?? current.assigneeId,
      solutionSummary: effectiveSolution,
      identifiedCause: effectiveCause,
      responsibleArea: effectiveArea,
      correctiveAction: effectiveAction,
      reopenedReason: current.status === 'COMPLETED' ? input.reason : current.reopenedReason,
      cancellationReason: input.status === 'CANCELLED' ? input.reason : current.cancellationReason,
      completedAt: input.status === 'COMPLETED' ? activityAt : (input.status === 'CANCELLED' ? (current.completedAt ?? activityAt) : null), lastOperationalActivityAt: activityAt,
    } });
    if (changed.count !== 1) throw new SacRecordError('STALE_SAC_RECORD', 'Este caso foi atualizado por outro usuário. Recarregue as informações antes de continuar.', 409);
    await tx.activityLog.create({ data: { recordId, actorId, eventType, summary: `Status alterado de ${current.status} para ${input.status}.`, before: { status: current.status, assigneeId: current.assigneeId }, after: { status: input.status, reason: input.reason, assumedBy: assumedBy?.name, solutionSummary: input.status === 'COMPLETED' ? effectiveSolution : undefined, identifiedCause: input.status === 'COMPLETED' ? effectiveCause : undefined, responsibleArea: input.status === 'COMPLETED' ? effectiveArea : undefined, correctiveAction: input.status === 'COMPLETED' ? effectiveAction : undefined }, createdAt: activityAt } });
    const notificationType = eventType === 'REOPENED' ? 'REOPENED' : eventType === 'CANCELLED' ? 'CANCELLED' : eventType === 'COMPLETED' ? 'COMPLETED' : 'STATUS_CHANGED';
    const notificationTitle = eventType === 'REOPENED' ? 'Caso reaberto' : eventType === 'CANCELLED' ? 'Caso cancelado' : eventType === 'COMPLETED' ? 'Caso concluído' : 'Status alterado';
    await createCaseNotification(tx, { recipientId: assumedBy?.id ?? current.assigneeId, actorId, recordId, ticket: current.ticket, type: notificationType, title: notificationTitle, summary: `${current.ticket} teve o status alterado para ${input.status}.`, metadata: { ticket: current.ticket, status: input.status } });
    return finishOperation(tx, recordId);
  });
}

export async function updateSacTreatment(recordId: string, input: z.infer<typeof updateTreatmentSchema>, actorId: string, actorRole: string = 'ADMIN', actorDepartment?: string | null) {
  return prisma.$transaction(async tx => {
    const current = await currentForOperation(tx, recordId, input.updatedAt, actorRole, actorDepartment);
    assertOperationalState(current.status);
    const activityAt = new Date();
    const changed = await tx.sacRecord.updateMany({
      where: { id: recordId, updatedAt: input.updatedAt },
      data: {
        solutionSummary: input.solutionSummary !== undefined ? input.solutionSummary : current.solutionSummary,
        identifiedCause: input.identifiedCause !== undefined ? input.identifiedCause : current.identifiedCause,
        responsibleArea: input.responsibleArea !== undefined ? input.responsibleArea : current.responsibleArea,
        correctiveAction: input.correctiveAction !== undefined ? input.correctiveAction : current.correctiveAction,
        lastOperationalActivityAt: activityAt,
      },
    });
    if (changed.count !== 1) throw new SacRecordError('STALE_SAC_RECORD', 'Este caso foi atualizado por outro usuário. Recarregue as informações antes de continuar.', 409);

    await tx.activityLog.create({
      data: {
        recordId,
        actorId,
        eventType: 'TREATMENT_UPDATED',
        summary: 'Resposta e tratativa operacional registradas.',
        before: {
          solutionSummary: current.solutionSummary,
          identifiedCause: current.identifiedCause,
          responsibleArea: current.responsibleArea,
          correctiveAction: current.correctiveAction,
        },
        after: {
          solutionSummary: input.solutionSummary !== undefined ? input.solutionSummary : current.solutionSummary,
          identifiedCause: input.identifiedCause !== undefined ? input.identifiedCause : current.identifiedCause,
          responsibleArea: input.responsibleArea !== undefined ? input.responsibleArea : current.responsibleArea,
          correctiveAction: input.correctiveAction !== undefined ? input.correctiveAction : current.correctiveAction,
        },
        createdAt: activityAt,
      },
    });

    return finishOperation(tx, recordId);
  });
}

export async function transferSacRecordDepartment(recordId: string, input: TransferDepartmentInput, actorId: string) {
  return prisma.$transaction(async tx => {
    const current = await tx.sacRecord.findFirst({
      where: { id: recordId, archivedAt: null },
      include: { assignee: true },
    });
    if (!current) throw new SacRecordError('SAC_RECORD_NOT_FOUND', 'Registro não encontrado.', 404);

    const targetDepartment = input.department.trim();
    if (!targetDepartment) throw new SacRecordError('DEPARTMENT_REQUIRED', 'Informe o novo setor.', 422);
    if (current.department === targetDepartment) {
      throw new SacRecordError('DEPARTMENT_UNCHANGED', 'O caso já pertence a este setor.', 422);
    }

    const activityAt = new Date();
    let newAssigneeId = current.assigneeId;
    let unassigned = false;

    // Se o responsável atual for um ANALYST e pertencer a outro setor, desvincula o responsável
    if (current.assignee && current.assignee.role === 'ANALYST' && current.assignee.department !== targetDepartment) {
      newAssigneeId = null;
      unassigned = true;
    }

    const previousDepartment = current.department;
    await tx.sacRecord.update({
      where: { id: recordId },
      data: {
        department: targetDepartment,
        assigneeId: newAssigneeId,
        lastOperationalActivityAt: activityAt,
      },
    });

    await tx.activityLog.create({
      data: {
        recordId,
        actorId,
        eventType: 'DEPARTMENT_TRANSFERRED',
        summary: previousDepartment
          ? `Setor transferido de ${previousDepartment} para ${targetDepartment}.${unassigned ? ' Responsável desvinculado por divergência de setor.' : ''}`
          : `Setor definido como ${targetDepartment}.${unassigned ? ' Responsável desvinculado por divergência de setor.' : ''}`,
        before: { department: previousDepartment, assigneeId: current.assigneeId },
        after: { department: targetDepartment, assigneeId: newAssigneeId, justification: input.justification ?? null },
        createdAt: activityAt,
      },
    });

    await tx.adminAudit.create({
      data: {
        type: 'CASES_TRANSFERRED',
        actorId,
        targetUserId: current.assigneeId ?? null,
        justification: input.justification ?? null,
        metadata: {
          recordId,
          ticket: current.ticket,
          previousDepartment,
          newDepartment: targetDepartment,
          unassigned,
        },
      },
    });

    if (newAssigneeId && newAssigneeId !== actorId) {
      await createCaseNotification(tx, {
        recipientId: newAssigneeId,
        actorId,
        recordId,
        ticket: current.ticket,
        type: 'STATUS_CHANGED',
        title: 'Setor do caso alterado',
        summary: `${current.ticket} foi transferido para o setor ${targetDepartment}.`,
        metadata: { ticket: current.ticket, department: targetDepartment },
      });
    }

    return finishOperation(tx, recordId);
  });
}

export async function revealSacRecordSensitive(recordId: string, field: string | undefined, actorId: string, userRole: string = 'ADMIN', userDepartment?: string | null) {
  if (userRole !== 'ADMIN') {
    throw new SacRecordError('FORBIDDEN', 'Apenas administradores podem revelar dados sensíveis.', 403);
  }

  const record = await prisma.sacRecord.findFirst({
    where: { id: recordId, archivedAt: null },
    include: { customer: true },
  });
  if (!record) {
    throw new SacRecordError('SAC_RECORD_NOT_FOUND', 'Registro não encontrado.', 404);
  }

  let revealedValue: string | null = null;
  let category: SensitiveCategory = 'CPF_CNPJ';
  const fieldPath = field || 'customer.document';

  if (field === 'customer.document' || field === 'customerDocument' || !field) {
    revealedValue = record.customer?.document || null;
    category = 'CPF_CNPJ';
  } else {
    throw new SacRecordError('INVALID_FIELD', 'Campo sensível inválido.', 400);
  }

  if (!revealedValue) {
    throw new SacRecordError('FIELD_EMPTY', 'O campo solicitado não possui valor cadastrado.', 404);
  }

  await logSensitiveDataRevealAudit({
    actorId,
    resourceType: 'SAC_RECORD',
    resourceId: recordId,
    category,
    fieldPath,
  });

  return { revealedValue, category, fieldPath };
}

export async function deleteSacRecord(
  recordId: string,
  input: DeleteSacRecordInput,
  actorId: string,
  actorRole: string = 'ADMIN',
  actorDepartment?: string | null,
) {
  if (actorRole !== 'ADMIN') {
    throw new SacRecordError('FORBIDDEN', 'Você não tem permissão para esta ação.', 403);
  }

  return prisma.$transaction(async tx => {
    const current = await currentForOperation(tx, recordId, input.updatedAt, actorRole, actorDepartment);
    const actor = await tx.user.findUniqueOrThrow({ where: { id: actorId }, select: { id: true, name: true, role: true } });
    if (actor.role !== 'ADMIN') {
      throw new SacRecordError('FORBIDDEN', 'Você não tem permissão para esta ação.', 403);
    }

    const activityAt = new Date();
    const changed = await tx.sacRecord.updateMany({
      where: {
        id: recordId,
        updatedAt: input.updatedAt,
        archivedAt: null,
      },
      data: {
        archivedAt: activityAt,
        deletedAt: activityAt,
        deletedById: actorId,
        deletionReason: input.justification,
        lastOperationalActivityAt: activityAt,
      },
    });

    if (changed.count !== 1) {
      throw new SacRecordError('STALE_SAC_RECORD', 'Este caso foi atualizado por outro usuário. Recarregue as informações antes de continuar.', 409);
    }

    await tx.activityLog.create({
      data: {
        recordId,
        actorId,
        eventType: 'SAC_DELETED',
        summary: `Registro SAC excluído por ${actor.name}. Justificativa: ${input.justification}`,
        before: {
          status: current.status,
          priority: current.priority,
          assigneeId: current.assigneeId,
          department: current.department,
          updatedAt: current.updatedAt,
        },
        after: {
          archivedAt: activityAt,
          deletedAt: activityAt,
          deletedById: actorId,
          justification: input.justification,
        },
        createdAt: activityAt,
      },
    });

    await tx.adminAudit.create({
      data: {
        type: 'CASE_DELETED',
        actorId,
        justification: input.justification,
        metadata: {
          recordId,
          ticket: current.ticket,
          department: current.department,
          status: current.status,
          priority: current.priority,
          deletedAt: activityAt.toISOString(),
        },
      },
    });

    return {
      id: recordId,
      ticket: current.ticket,
      deleted: true,
      deletedAt: activityAt.toISOString(),
      message: `Registro ${current.ticket} excluído com sucesso.`,
    };
  });
}

