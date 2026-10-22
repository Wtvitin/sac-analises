import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import {
  ALLOWED_ATTACHMENT_TYPES, AttachmentStorageError, MAX_ATTACHMENT_COUNT, MAX_ATTACHMENT_SIZE, getAttachmentStorage,
} from '../../lib/attachment-storage.js';
import {
  assignmentSchema, changeStatusSchema, commentSchema, createSacRecordSchema, customerSearchSchema, deleteSacRecordSchema, dueDateChangeSchema, externalTicketCheckSchema, historyQuerySchema, idempotencyKeySchema,
  listSacRecordsSchema, priorityChangeSchema, takeCaseSchema, transferDepartmentSchema, updateSacRecordSchema, updateTreatmentSchema,
} from './sac.schema.js';
import {
  SacRecordError, addSacComment, assignSacRecord, changeSacDueDate, changeSacPriority, changeSacStatus, checkExternalTicket, createSacRecord, deleteSacRecord, getSacHistory, getSacRecord, listSacRecords, revealSacRecordSensitive, searchCustomers, takeSacRecord, transferSacRecordDepartment, updateSacRecord, updateSacTreatment,
} from './sac.service.js';
import { requirePermission, requireRole } from '../auth/auth.middleware.js';

export const sacRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_SIZE, files: MAX_ATTACHMENT_COUNT, fields: 20 },
  fileFilter: (_req, file, callback) => {
    if (!ALLOWED_ATTACHMENT_TYPES.has(file.mimetype)) {
      callback(new AttachmentStorageError('INVALID_ATTACHMENT_TYPE', 'Envie somente arquivos PDF, JPG, JPEG ou PNG.'));
      return;
    }
    callback(null, true);
  },
});

function parsePayload(body: Record<string, unknown>) {
  if (typeof body.payload !== 'string') return body;
  try { return JSON.parse(body.payload) as unknown; }
  catch { throw new SacRecordError('INVALID_FORM_PAYLOAD', 'Os dados enviados são inválidos.', 422); }
}

async function persistFiles(req: Request) {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  return getAttachmentStorage().save(files, req.auth?.userId);
}

sacRouter.get('/', async (req, res, next) => {
  try { res.json({ data: await listSacRecords(listSacRecordsSchema.parse(req.query), req.auth?.role ?? 'VIEWER', req.auth?.department ?? null) }); }
  catch (error) { next(error); }
});

sacRouter.get('/external-ticket-check', async (req, res, next) => {
  try { const input = externalTicketCheckSchema.parse(req.query); res.json({ data: await checkExternalTicket(input.value, req.auth?.role, req.auth?.department, input.excludeId) }); }
  catch (error) { next(error); }
});

sacRouter.get('/customer-options', async (req, res, next) => {
  try { const input = customerSearchSchema.parse(req.query); res.json({ data: await searchCustomers(input.query, req.auth?.role, req.auth?.department) }); }
  catch (error) { next(error); }
});

sacRouter.post('/', requirePermission('cases:write'), upload.array('files', MAX_ATTACHMENT_COUNT), async (req, res, next) => {
  let stored = [] as Awaited<ReturnType<typeof persistFiles>>;
  try {
    const key = idempotencyKeySchema.parse(req.header('Idempotency-Key'));
    const input = createSacRecordSchema.parse(parsePayload(req.body));
    stored = await persistFiles(req);
    const result = await createSacRecord(input, req.auth!.userId, req.auth!.role, req.auth!.department ?? null, key, stored);
    if (!result.created) await getAttachmentStorage().remove(stored);
    res.status(result.created ? 201 : 200).json({ data: { ...result.record, idempotencyKey: undefined, idempotentReplay: !result.created } });
  } catch (error) { if (stored.length) await getAttachmentStorage().remove(stored); next(error); }
});

sacRouter.get('/:id', async (req, res, next) => {
  try { res.json({ data: await getSacRecord(String(req.params.id), req.auth?.role ?? 'VIEWER', req.auth?.department ?? null) }); }
  catch (error) { next(error); }
});

sacRouter.patch('/:id', requirePermission('cases:write'), upload.array('files', MAX_ATTACHMENT_COUNT), async (req, res, next) => {
  let stored = [] as Awaited<ReturnType<typeof persistFiles>>;
  try {
    const input = updateSacRecordSchema.parse(parsePayload(req.body));
    stored = await persistFiles(req);
    const record = await updateSacRecord(String(req.params.id), input, req.auth!.userId, req.auth!.role, req.auth!.department ?? null, stored);
    res.json({ data: record });
  } catch (error) { if (stored.length) await getAttachmentStorage().remove(stored); next(error); }
});

sacRouter.patch('/:id/assignee', requirePermission('cases:write'), async (req, res, next) => {
  try { res.json({ data: await assignSacRecord(String(req.params.id), assignmentSchema.parse(req.body), req.auth!.userId, req.auth!.role, req.auth!.department ?? null) }); } catch (error) { next(error); }
});
sacRouter.post('/:id/take', requirePermission('cases:write'), async (req, res, next) => {
  try { res.json({ data: await takeSacRecord(String(req.params.id), takeCaseSchema.parse(req.body), req.auth!.userId, req.auth!.role, req.auth!.department ?? null) }); } catch (error) { next(error); }
});
sacRouter.patch('/:id/priority', requirePermission('cases:write'), async (req, res, next) => {
  try { res.json({ data: await changeSacPriority(String(req.params.id), priorityChangeSchema.parse(req.body), req.auth!.userId, req.auth!.role, req.auth!.department ?? null) }); } catch (error) { next(error); }
});
sacRouter.patch('/:id/due-date', requirePermission('cases:write'), async (req, res, next) => {
  try { res.json({ data: await changeSacDueDate(String(req.params.id), dueDateChangeSchema.parse(req.body), req.auth!.userId, req.auth!.role, req.auth!.department ?? null) }); } catch (error) { next(error); }
});
sacRouter.post('/:id/comments', requirePermission('cases:write'), async (req, res, next) => {
  try { res.status(201).json({ data: await addSacComment(String(req.params.id), commentSchema.parse(req.body), req.auth!.userId, req.auth!.role, req.auth!.department ?? null) }); } catch (error) { next(error); }
});
sacRouter.get('/:id/history', async (req, res, next) => {
  try { res.json({ data: await getSacHistory(String(req.params.id), historyQuerySchema.parse(req.query), req.auth?.role ?? 'VIEWER', req.auth?.department ?? null) }); } catch (error) { next(error); }
});

sacRouter.patch('/:id/treatment', requirePermission('cases:write'), async (req, res, next) => {
  try { res.json({ data: await updateSacTreatment(String(req.params.id), updateTreatmentSchema.parse(req.body), req.auth!.userId, req.auth!.role, req.auth!.department ?? null) }); }
  catch (error) { next(error); }
});

sacRouter.post('/:id/status', requirePermission('cases:write'), async (req, res, next) => {
  try { res.json({ data: await changeSacStatus(String(req.params.id), changeStatusSchema.parse(req.body), req.auth!.userId, req.auth!.role as 'ADMIN' | 'ANALYST', req.auth!.department ?? null) }); }
  catch (error) { next(error); }
});

sacRouter.post('/:id/reveal-sensitive', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const { field } = req.body || {};
    const result = await revealSacRecordSensitive(String(req.params.id), field, req.auth!.userId, req.auth!.role, req.auth!.department ?? null);
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

sacRouter.patch('/:id/department', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const input = transferDepartmentSchema.parse(req.body);
    const result = await transferSacRecordDepartment(String(req.params.id), input, req.auth!.userId);
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

sacRouter.delete('/:id', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const input = deleteSacRecordSchema.parse(req.body);
    const result = await deleteSacRecord(String(req.params.id), input, req.auth!.userId, req.auth!.role, req.auth!.department ?? null);
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

sacRouter.post('/:id/delete', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const input = deleteSacRecordSchema.parse(req.body);
    const result = await deleteSacRecord(String(req.params.id), input, req.auth!.userId, req.auth!.role, req.auth!.department ?? null);
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

sacRouter.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (error instanceof SacRecordError || error instanceof AttachmentStorageError) return res.status(error.status).json({ error: { code: error.code, message: error.message } });
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE' ? 'Cada arquivo deve possuir até 10 MB.' : `Envie no máximo ${MAX_ATTACHMENT_COUNT} arquivos.`;
    return res.status(422).json({ error: { code: error.code, message } });
  }
  return next(error);
});
