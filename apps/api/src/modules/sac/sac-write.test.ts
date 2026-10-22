import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSacRecordSchema, updateSacRecordSchema } from './sac.schema.js';

const mock = vi.hoisted(() => {
  const sacRecord = { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() };
  const database = {
    sacRecord,
    reason: { findUnique: vi.fn() }, channel: { findUnique: vi.fn() }, subreason: { findUnique: vi.fn() }, user: { findUnique: vi.fn() },
    customer: { upsert: vi.fn() }, ticketCounter: { upsert: vi.fn() }, sacItem: { deleteMany: vi.fn(), createMany: vi.fn() },
    sacReference: { deleteMany: vi.fn(), createMany: vi.fn() },
    attachment: { createMany: vi.fn() }, activityLog: { create: vi.fn() },
    adminAudit: { create: vi.fn() },
  };
  return { database, sacRecord, transaction: vi.fn(async (callback: (tx: typeof database) => unknown) => callback(database)) };
});

vi.mock('../../lib/prisma.js', () => ({ prisma: { ...mock.database, $transaction: mock.transaction } }));
import { createSacRecord, revealSacRecordSensitive, updateSacRecord } from './sac.service.js';

const input = {
  customerName: 'Cliente Alfa', orderNumber: 'PED-123', externalTicket: '', channelId: 'channel-1', reasonId: 'reason-1', subreasonId: '',
  description: 'Descrição completa da ocorrência.', internalNote: '', identifiedCause: '', responsibleArea: '', correctiveAction: '',
  priority: 'HIGH' as const, assigneeId: '', openedAt: new Date('2026-09-14T12:00:00Z'), dueAt: new Date('2026-09-16T02:59:59Z'), items: [], allowDuplicateExternalTicket: false,
};

describe('SAC creation and editing persistence (isolated)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.database.reason.findUnique.mockResolvedValue({ id: 'reason-1', name: 'Avaria', active: true });
    mock.database.channel.findUnique.mockResolvedValue({ id: 'channel-1', name: 'E-mail', active: true });
    mock.database.customer.upsert.mockResolvedValue({ id: 'customer-1' });
    mock.database.ticketCounter.upsert.mockResolvedValue({ year: 2026, value: 7 });
    mock.database.activityLog.create.mockResolvedValue({ id: 'activity-1' });
    mock.database.sacItem.deleteMany.mockResolvedValue({ count: 0 });
    mock.database.sacItem.createMany.mockResolvedValue({ count: 0 });
    mock.database.sacReference.deleteMany.mockResolvedValue({ count: 0 });
    mock.database.sacReference.createMany.mockResolvedValue({ count: 0 });
    mock.database.attachment.createMany.mockResolvedValue({ count: 0 });
  });

  it('creates a sequential immutable ticket with customer reuse and an audit event', async () => {
    const saved = { id: 'sac-1', ticket: 'SAC-2026-0007' };
    mock.sacRecord.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mock.sacRecord.create.mockResolvedValue({ id: 'sac-1' }); mock.sacRecord.findUniqueOrThrow.mockResolvedValue(saved);
    const result = await createSacRecord(createSacRecordSchema.parse(input), 'admin-1', 'b5215944-a474-4b7f-9efe-f9d3e80b7c1d');
    expect(result).toMatchObject({ record: saved, created: true });
    expect(mock.sacRecord.create.mock.calls[0][0].data).toMatchObject({ ticket: 'SAC-2026-0007', customerId: 'customer-1', channel: 'E-mail', createdById: 'admin-1' });
    expect(mock.database.activityLog.create.mock.calls[0][0].data).toMatchObject({ recordId: 'sac-1', eventType: 'CREATED' });
  });

  it('reports a concurrent idempotent replay instead of duplicating the record', async () => {
    const replay = { id: 'sac-existing', ticket: 'SAC-2026-0006' };
    mock.sacRecord.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(replay);
    await expect(createSacRecord(createSacRecordSchema.parse(input), 'admin-1', 'dc81f9a5-8383-452b-81f9-b6fc78e73df8')).resolves.toMatchObject({ record: replay, created: false });
    expect(mock.sacRecord.create).not.toHaveBeenCalled();
  });

  it('updates with optimistic concurrency, replaces items and records before/after audit data', async () => {
    const updatedAt = new Date('2026-09-14T13:00:00Z'); const saved = { id: 'sac-1', ticket: 'SAC-2026-0007' };
    mock.sacRecord.findFirst.mockResolvedValue({ ...updateSacRecordSchema.parse({ ...input, updatedAt }), id: 'sac-1', channelId: 'channel-1', items: [], _count: { attachments: 0 } });
    mock.sacRecord.updateMany.mockResolvedValue({ count: 1 }); mock.sacRecord.findUniqueOrThrow.mockResolvedValue(saved);
    const edit = updateSacRecordSchema.parse({ ...input, updatedAt, items: [{ code: 'SKU-1', description: 'Produto teste', quantity: 2 }] });
    await expect(updateSacRecord('sac-1', edit, 'admin-1')).resolves.toMatchObject(saved);
    expect(mock.database.sacItem.deleteMany).toHaveBeenCalledWith({ where: { recordId: 'sac-1' } });
    expect(mock.database.sacItem.createMany.mock.calls[0][0].data[0]).toMatchObject({ recordId: 'sac-1', code: 'SKU-1', quantity: 2 });
    expect(mock.database.activityLog.create.mock.calls[0][0].data).toMatchObject({ eventType: 'UPDATED', before: { itemCount: 0 }, after: { itemCount: 1 } });
  });

  it('rejects stale edits before changing related data', async () => {
    const updatedAt = new Date('2026-09-14T13:00:00Z');
    mock.sacRecord.findFirst.mockResolvedValue({ ...updateSacRecordSchema.parse({ ...input, updatedAt }), id: 'sac-1', updatedAt: new Date('2026-09-14T13:01:00Z'), items: [], _count: { attachments: 0 } });
    const edit = updateSacRecordSchema.parse({ ...input, updatedAt });
    await expect(updateSacRecord('sac-1', edit, 'admin-1')).rejects.toMatchObject({ code: 'STALE_SAC_RECORD', status: 409 });
    expect(mock.sacRecord.updateMany).not.toHaveBeenCalled();
  });

  it('enforces the attachment limit across multiple edits', async () => {
    const updatedAt = new Date('2026-09-14T13:00:00Z');
    mock.sacRecord.findFirst.mockResolvedValue({ ...updateSacRecordSchema.parse({ ...input, updatedAt }), id: 'sac-1', updatedAt, items: [], _count: { attachments: 5 } });
    const edit = updateSacRecordSchema.parse({ ...input, updatedAt });
    const attachment = { originalName: 'evidencia.pdf', mimeType: 'application/pdf', sizeBytes: 1024, storageKey: 'stored.pdf' };
    await expect(updateSacRecord('sac-1', edit, 'admin-1', [attachment])).rejects.toMatchObject({ code: 'TOO_MANY_ATTACHMENTS', status: 422 });
    expect(mock.sacRecord.updateMany).not.toHaveBeenCalled();
  });

  it('creates case without orderNumber but with multisector references and masks customer document', async () => {
    const inputWithoutOrder = {
      ...input,
      orderNumber: undefined,
      references: [
        { type: 'INVOICE' as const, value: 'NF-998877', note: 'Nota fiscal' },
        { type: 'SERVICE_ORDER' as const, value: 'OS-1234', note: 'Ordem de serviço' },
      ],
    };
    const parsed = createSacRecordSchema.parse(inputWithoutOrder);
    expect(parsed.orderNumber).toBeNull();
    expect(parsed.references).toHaveLength(2);

    const saved = {
      id: 'sac-2',
      ticket: 'SAC-2026-0008',
      orderNumber: null,
      customer: { id: 'cust-1', name: 'Cliente Alfa', document: '123.456.789-00' },
      references: [
        { id: 'ref-1', type: 'INVOICE', value: 'NF-998877' },
        { id: 'ref-2', type: 'SERVICE_ORDER', value: 'OS-1234' },
      ],
    };

    mock.sacRecord.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mock.sacRecord.create.mockResolvedValue({ id: 'sac-2' });
    mock.sacRecord.findUniqueOrThrow.mockResolvedValue(saved);

    const result = await createSacRecord(parsed, 'admin-1', 'b5215944-a474-4b7f-9efe-f9d3e80b7c2e');
    expect(result.created).toBe(true);
    // Customer document must be masked in response to exact '***' without digits
    expect(result.record.customer.document).toBe('***');
    expect(result.record.customer.document).not.toContain('789');
    expect(result.record.customer.isDocumentMasked).toBe(true);

    const createCall = mock.sacRecord.create.mock.calls[0][0];
    expect(createCall.data.orderNumber).toBeNull();
    expect(createCall.data.references.create).toHaveLength(2);
  });

  it('allows ADMIN to reveal customer document on SAC record and logs audit without storing value', async () => {
    mock.sacRecord.findFirst.mockResolvedValue({
      id: 'sac-2',
      customer: { id: 'cust-1', document: '123.456.789-00' },
    });
    mock.database.adminAudit.create.mockResolvedValue({});

    const result = await revealSacRecordSensitive('sac-2', 'customerDocument', 'admin-1', 'ADMIN');
    expect(result.revealedValue).toBe('123.456.789-00');
    expect(result.category).toBe('CPF_CNPJ');

    expect(mock.database.adminAudit.create).toHaveBeenCalledTimes(1);
    const auditCall = mock.database.adminAudit.create.mock.calls[0][0];
    expect(auditCall.data.type).toBe('SENSITIVE_DATA_REVEALED');
    expect(auditCall.data.actorId).toBe('admin-1');
    expect(auditCall.data.metadata.category).toBe('CPF_CNPJ');
    expect(auditCall.data.metadata.resourceType).toBe('SAC_RECORD');
    expect(auditCall.data.metadata.resourceId).toBe('sac-2');
    expect(JSON.stringify(auditCall.data)).not.toContain('123.456.789-00');
  });

  it('rejects non-admin (ANALYST, VIEWER) from revealing sensitive customer document on SAC record', async () => {
    await expect(revealSacRecordSensitive('sac-2', 'customerDocument', 'analyst-1', 'ANALYST'))
      .rejects.toThrow('Apenas administradores podem revelar dados sensíveis.');
    await expect(revealSacRecordSensitive('sac-2', 'customerDocument', 'viewer-1', 'VIEWER'))
      .rejects.toThrow('Apenas administradores podem revelar dados sensíveis.');
  });
});

