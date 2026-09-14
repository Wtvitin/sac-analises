import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hasRole } from '../auth/auth.middleware.js';
import {
  catalogEntrySchema, cleanCatalogName, listCatalogSchema, listSubreasonsSchema,
  normalizeCatalogName, subreasonEntrySchema, updateCatalogEntrySchema,
} from './catalog.schema.js';

const mock = vi.hoisted(() => {
  const reason = { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() };
  const subreason = { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() };
  const channel = { findMany: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn() };
  const database = { reason, subreason, channel } as Record<string, unknown>;
  Object.assign(database, { $transaction: vi.fn(async (input: unknown) => typeof input === 'function' ? (input as (tx: unknown) => unknown)(database) : Promise.all(input as Promise<unknown>[])) });
  return { reason, subreason, channel, database };
});

vi.mock('../../lib/prisma.js', () => ({ prisma: mock.database }));
import { CatalogError, createChannel, createReason, createSubreason, listReasons, listSubreasons, setReasonStatus, updateReason } from './catalog.service.js';
import { deletionDisabled } from './catalog.routes.js';

describe('catalog validation and normalization', () => {
  it('cleans outer and repeated spaces and normalizes case', () => {
    expect(cleanCatalogName('  Entrega   atrasada  ')).toBe('Entrega atrasada');
    expect(normalizeCatalogName('  ENTREGA   Atrasada  ')).toBe('entrega atrasada');
  });

  it('rejects empty names, oversized descriptions and invalid order', () => {
    expect(catalogEntrySchema.safeParse({ name: '   ', description: '', active: true, displayOrder: 0 }).success).toBe(false);
    expect(catalogEntrySchema.safeParse({ name: 'Válido', description: 'x'.repeat(501), displayOrder: 0 }).success).toBe(false);
    expect(catalogEntrySchema.safeParse({ name: 'Válido', description: '', displayOrder: -1 }).success).toBe(false);
    expect(updateCatalogEntrySchema.safeParse({}).success).toBe(false);
  });

  it('requires a parent reason for subreasons and validates pagination', () => {
    expect(subreasonEntrySchema.safeParse({ name: 'Detalhe', reasonId: '', displayOrder: 0 }).success).toBe(false);
    expect(listCatalogSchema.parse({})).toMatchObject({ status: 'all', page: 1, pageSize: 20 });
    expect(listSubreasonsSchema.safeParse({ pageSize: 101 }).success).toBe(false);
  });
});

describe('catalog persistence service (isolated)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.reason.findMany.mockResolvedValue([]); mock.reason.count.mockResolvedValue(0);
    mock.subreason.findMany.mockResolvedValue([]); mock.subreason.count.mockResolvedValue(0);
    mock.channel.findMany.mockResolvedValue([]); mock.channel.count.mockResolvedValue(0);
  });

  it('applies search, state, pagination and deterministic ordering', async () => {
    await listReasons(listCatalogSchema.parse({ query: 'entrega', status: 'inactive', page: 2, pageSize: 10 }), true);
    expect(mock.reason.findMany.mock.calls[0][0]).toMatchObject({ where: { active: false }, skip: 10, take: 10, orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }] });
    await listReasons(listCatalogSchema.parse({ status: 'all' }), false);
    expect(mock.reason.findMany.mock.calls[1][0].where.active).toBe(true);
  });

  it('normalizes a new reason and prevents concurrent duplicates through the database key', async () => {
    mock.reason.create.mockResolvedValue({ id: 'reason-1' });
    await createReason(catalogEntrySchema.parse({ name: '  Entrega   atrasada ', description: '', active: true, displayOrder: 2 }));
    expect(mock.reason.create.mock.calls[0][0].data).toMatchObject({ name: 'Entrega atrasada', normalizedName: 'entrega atrasada', description: null, displayOrder: 2 });
    mock.reason.create.mockRejectedValueOnce({ code: 'P2002' });
    await expect(createReason(catalogEntrySchema.parse({ name: 'ENTREGA ATRASADA', displayOrder: 0 }))).rejects.toMatchObject({ code: 'DUPLICATE_CATALOG_ENTRY', status: 409 });
  });

  it('edits and inactivates without deleting the catalog entry', async () => {
    mock.reason.update.mockResolvedValue({ id: 'reason-1', active: false }); mock.subreason.count.mockResolvedValue(2);
    await updateReason('reason-1', updateCatalogEntrySchema.parse({ name: 'Novo nome' }));
    expect(mock.reason.update.mock.calls[0][0].data.normalizedName).toBe('novo nome');
    expect(await setReasonStatus('reason-1', false)).toMatchObject({ active: false, activeSubreasons: 2 });
  });

  it('rejects a subreason without an existing active parent', async () => {
    mock.reason.findUnique.mockResolvedValueOnce(null);
    await expect(createSubreason(subreasonEntrySchema.parse({ name: 'Detalhe', reasonId: 'missing', displayOrder: 0 }))).rejects.toBeInstanceOf(CatalogError);
    mock.reason.findUnique.mockResolvedValueOnce({ active: false });
    await expect(createSubreason(subreasonEntrySchema.parse({ name: 'Detalhe', reasonId: 'inactive', displayOrder: 0 }))).rejects.toMatchObject({ code: 'INACTIVE_REASON' });
  });

  it('allows equal subreason names under different parents and filters by parent', async () => {
    await listSubreasons(listSubreasonsSchema.parse({ reasonId: 'reason-2' }), true);
    expect(mock.subreason.findMany.mock.calls[0][0].where.reasonId).toBe('reason-2');
    mock.reason.findUnique.mockResolvedValue({ active: true }); mock.subreason.create.mockResolvedValue({ id: 'sub-1' });
    await createSubreason(subreasonEntrySchema.parse({ name: 'Detalhe', reasonId: 'reason-1', displayOrder: 0 }));
    await createSubreason(subreasonEntrySchema.parse({ name: 'Detalhe', reasonId: 'reason-2', displayOrder: 0 }));
    expect(mock.subreason.create.mock.calls.map(call => call[0].data.reasonId)).toEqual(['reason-1', 'reason-2']);
  });

  it('persists channels and enforces API roles without permanent test users', async () => {
    mock.channel.create.mockResolvedValue({ id: 'channel-1' });
    await createChannel(catalogEntrySchema.parse({ name: 'Canal interno', displayOrder: 1 }));
    expect(mock.channel.create.mock.calls[0][0].data.normalizedName).toBe('canal interno');
    expect(hasRole('ADMIN', ['ADMIN'])).toBe(true);
    expect(hasRole('ANALYST', ['ADMIN'])).toBe(false);
    expect(hasRole('VIEWER', ['ADMIN'])).toBe(false);
  });

  it('refuses permanent deletion and directs the administrator to inactivation', () => {
    const json = vi.fn(); const status = vi.fn(() => ({ json }));
    deletionDisabled({} as never, { status } as never);
    expect(status).toHaveBeenCalledWith(405);
    expect(json).toHaveBeenCalledWith({ error: { code: 'PERMANENT_DELETION_DISABLED', message: 'Use a inativação para preservar o histórico.' } });
  });
});
