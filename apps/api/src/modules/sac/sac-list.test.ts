import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listSacRecordsSchema } from './sac.schema.js';

const mock = vi.hoisted(() => ({ findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn(), owners: vi.fn(), reasons: vi.fn() }));
vi.mock('../../lib/prisma.js', () => ({ prisma: {
  sacRecord: { findMany: mock.findMany, count: mock.count, groupBy: mock.groupBy },
  user: { findMany: mock.owners }, reason: { findMany: mock.reasons },
  $transaction: (queries: unknown[]) => Promise.all(queries),
} }));
import { listSacRecords } from './sac.service.js';

describe('server record listing (isolated, no database writes)', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mock.findMany.mockResolvedValue([]); mock.count.mockResolvedValue(0);
    mock.groupBy.mockResolvedValue([]); mock.owners.mockResolvedValue([]); mock.reasons.mockResolvedValue([]);
  });
  it('keeps the existing defaults and validates limits and periods', () => {
    expect(listSacRecordsSchema.parse({})).toMatchObject({ page: 1, pageSize: 20, sort: 'updatedAt', order: 'desc' });
    expect(listSacRecordsSchema.safeParse({ pageSize: 101 }).success).toBe(false);
    expect(listSacRecordsSchema.safeParse({ openedFrom: '2026-09-15T00:00:00Z', openedTo: '2026-09-12T00:00:00Z' }).success).toBe(false);
  });
  it('queries past the first 100 records with stable server sorting', async () => {
    mock.findMany.mockResolvedValue([{ ticket: 'TEST-101' }]); mock.count.mockResolvedValue(121);
    const result = await listSacRecords(listSacRecordsSchema.parse({ page: 6, pageSize: 20, sort: 'customer', order: 'asc' }));
    expect(mock.findMany.mock.calls[0][0]).toMatchObject({ skip: 100, take: 20, orderBy: [{ customer: { name: 'asc' } }, { id: 'asc' }] });
    expect(result).toMatchObject({ items: [{ ticket: 'TEST-101' }], total: 121, page: 6 });
  });
  it('applies combined filters and reason search before pagination and count', async () => {
    await listSacRecords(listSacRecordsSchema.parse({ query: 'avaria', priority: 'HIGH', status: 'PENDING', reason: 'Avaria', unassigned: 'true', overdueBefore: '2026-09-12T03:00:00Z' }));
    const where = mock.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ priority: 'HIGH', status: 'PENDING', reason: { name: 'Avaria' }, assigneeId: null });
    expect(where.OR).toContainEqual({ reason: { name: { contains: 'avaria', mode: 'insensitive' } } });
    expect(where.AND).toContainEqual({ status: { not: 'COMPLETED' } });
    expect(mock.count.mock.calls[0][0]).toEqual({ where });
  });
  it('returns empty items and real zero totals without fabricated pages', async () => {
    expect(await listSacRecords(listSacRecordsSchema.parse({}))).toMatchObject({ items: [], total: 0 });
  });
});
