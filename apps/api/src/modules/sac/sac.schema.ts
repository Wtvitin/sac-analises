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
  attention: z.enum(['required', 'overdue', 'dueToday', 'nearDue', 'stale', 'unassigned', 'noDue']).optional(),
  department: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['ticket', 'customer', 'status', 'openedAt', 'createdAt', 'dueAt', 'priority', 'updatedAt', 'attention']).default('updatedAt'),
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
export const updateTreatmentSchema = z.object({
  updatedAt: z.coerce.date(),
  solutionSummary: z.string().trim().max(5000).optional().nullable(),
  identifiedCause: z.string().trim().max(2000).optional().nullable(),
  responsibleArea: z.string().trim().max(160).optional().nullable(),
  correctiveAction: z.string().trim().max(2000).optional().nullable(),
});
export const historyQuerySchema = z.object({ page: z.coerce.number().int().positive().default(1), pageSize: z.coerce.number().int().min(1).max(100).default(30) });

const optionalText = (max: number) => z.string().max(max).optional().transform(value => value?.trim() || null);

const optionalBatch = () =>
  z
    .string()
    .max(80)
    .optional()
    .nullable()
    .transform(value => {
      if (!value) return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      // Regra: "Não grave o aviso como valor do lote."
      if (/^o\s+lote\s+n[ãa]o\s+foi\s+informado/i.test(trimmed)) return null;
      return trimmed;
    });

export const sacItemSchema = z.object({
  code: z.string().trim().min(1, 'Informe o código ou SKU.').max(80),
  description: z.string().trim().min(2, 'Informe a descrição do item.').max(300),
  batch: optionalBatch(),
  quantity: z.coerce.number().positive('A quantidade deve ser maior que zero.').max(999999999),
  note: optionalText(500),
});

export const sacReferenceTypeSchema = z.enum([
  'ORDER',
  'INVOICE',
  'SERVICE_ORDER',
  'PROTOCOL',
  'ATTENDANCE',
  'CUSTOMER_CODE',
  'INTERNAL_DOC',
  'OTHER',
]);

export const sacReferenceSchema = z.object({
  type: sacReferenceTypeSchema,
  value: z.string().trim().min(1, 'Informe o valor da referência.').max(120),
  note: optionalText(300),
});

const sacRecordFields = {
  customerName: z.string().transform(value => value.trim().replace(/\s+/g, ' ')).pipe(z.string().min(2).max(160)),
  orderNumber: optionalText(80),
  externalTicket: optionalText(80),
  references: z.array(sacReferenceSchema).max(20, 'Adicione no máximo 20 referências.').default([]),
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
  department: z.string().trim().max(100).optional().transform(value => value || null),
  allowDuplicateExternalTicket: z.boolean().default(false),
  importSessionId: z.string().trim().optional(),
  preserveImportAsAttachment: z.boolean().default(false),
}).refine(validDates, { path: ['dueAt'], message: 'O prazo não pode ser anterior à data de abertura.' });

export const updateSacRecordSchema = z.object({
  ...sacRecordFields,
  updatedAt: z.coerce.date(),
  allowDuplicateExternalTicket: z.boolean().default(false),
}).refine(validDates, { path: ['dueAt'], message: 'O prazo não pode ser anterior à data de abertura.' });

export const transferDepartmentSchema = z.object({
  department: z.string().trim().min(1, 'Informe o novo setor.').max(100),
  justification: z.string().trim().max(1000).optional(),
});

export const idempotencyKeySchema = z.string().uuid('Chave de idempotência inválida.');
export const externalTicketCheckSchema = z.object({ value: z.string().trim().min(1).max(80), excludeId: z.string().trim().optional() });
export const customerSearchSchema = z.object({ query: z.string().trim().max(120).default('') });

export const deleteSacRecordSchema = z.object({
  updatedAt: z.coerce.date(),
  justification: z.string().trim().min(5, 'Informe uma justificativa com no mínimo 5 caracteres.').max(1000, 'A justificativa deve conter no máximo 1000 caracteres.'),
});

export type DeleteSacRecordInput = z.infer<typeof deleteSacRecordSchema>;
