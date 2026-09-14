import { z } from 'zod';

export const listSacRecordsSchema = z.object({
  query: z.string().trim().max(120).optional(),
  status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  owner: z.string().trim().max(160).optional(),
  reason: z.string().trim().max(160).optional(),
  openedFrom: z.iso.datetime({ offset: true }).optional(),
  openedTo: z.iso.datetime({ offset: true }).optional(),
  dueFrom: z.iso.datetime({ offset: true }).optional(),
  dueTo: z.iso.datetime({ offset: true }).optional(),
  overdueBefore: z.iso.datetime({ offset: true }).optional(),
  unassigned: z.enum(['true']).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['ticket', 'customer', 'status', 'openedAt', 'dueAt', 'priority', 'updatedAt']).default('updatedAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
}).refine(input => !input.openedFrom || !input.openedTo || new Date(input.openedFrom) < new Date(input.openedTo), { message: 'Período inválido.', path: ['openedTo'] });

export const changeStatusSchema = z.object({
  status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']),
  updatedAt: z.coerce.date(),
  solutionSummary: z.string().trim().max(5000).optional(),
  identifiedCause: z.string().trim().max(2000).optional(),
  responsibleArea: z.string().trim().max(160).optional(),
  correctiveAction: z.string().trim().max(2000).optional(),
  reason: z.string().trim().max(2000).optional(),
  assumeIfUnassigned: z.boolean().default(false),
});

export const assignmentSchema = z.object({ updatedAt: z.coerce.date(), assigneeId: z.string().trim().nullable(), justification: z.string().trim().max(1000).optional() });
export const takeCaseSchema = z.object({ updatedAt: z.coerce.date() });
export const priorityChangeSchema = z.object({ updatedAt: z.coerce.date(), priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']), justification: z.string().trim().max(1000).optional() });
export const dueDateChangeSchema = z.object({ updatedAt: z.coerce.date(), dueAt: z.coerce.date(), justification: z.string().trim().max(1000).optional() });
export const commentSchema = z.object({ updatedAt: z.coerce.date(), body: z.string().trim().min(1, 'Escreva um comentário.').max(4000) });
export const historyQuerySchema = z.object({ page: z.coerce.number().int().positive().default(1), pageSize: z.coerce.number().int().min(1).max(100).default(30) });

const optionalText = (max: number) => z.string().max(max).optional().transform(value => value?.trim() || null);

export const sacItemSchema = z.object({
  code: z.string().trim().min(1, 'Informe o código ou SKU.').max(80),
  description: z.string().trim().min(2, 'Informe a descrição do item.').max(300),
  batch: optionalText(80),
  quantity: z.coerce.number().positive('A quantidade deve ser maior que zero.').max(999999999),
  note: optionalText(500),
});

const sacRecordFields = {
  customerName: z.string().transform(value => value.trim().replace(/\s+/g, ' ')).pipe(z.string().min(2).max(160)),
  orderNumber: z.string().trim().min(1).max(40),
  externalTicket: optionalText(80),
  channelId: z.string().trim().min(1, 'Selecione um canal.'),
  reasonId: z.string().trim().min(1, 'Selecione um motivo.'),
  subreasonId: z.string().trim().optional().transform(value => value || null),
  description: z.string().trim().min(10).max(5000),
  internalNote: optionalText(2000),
  identifiedCause: optionalText(2000),
  responsibleArea: optionalText(160),
  correctiveAction: optionalText(2000),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  assigneeId: z.string().trim().optional().transform(value => value || null),
  openedAt: z.coerce.date(),
  dueAt: z.coerce.date(),
  items: z.array(sacItemSchema).max(50, 'Adicione no máximo 50 itens.'),
};

function validDates(input: { openedAt: Date; dueAt: Date }) { return input.dueAt >= input.openedAt; }

export const createSacRecordSchema = z.object({
  ...sacRecordFields,
  allowDuplicateExternalTicket: z.boolean().default(false),
}).refine(validDates, { path: ['dueAt'], message: 'O prazo não pode ser anterior à data de abertura.' });

export const updateSacRecordSchema = z.object({
  ...sacRecordFields,
  updatedAt: z.coerce.date(),
  allowDuplicateExternalTicket: z.boolean().default(false),
}).refine(validDates, { path: ['dueAt'], message: 'O prazo não pode ser anterior à data de abertura.' });

export const idempotencyKeySchema = z.string().uuid('Chave de idempotência inválida.');
export const externalTicketCheckSchema = z.object({ value: z.string().trim().min(1).max(80), excludeId: z.string().trim().optional() });
export const customerSearchSchema = z.object({ query: z.string().trim().max(120).default('') });
