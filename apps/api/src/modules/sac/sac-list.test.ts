import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listSacRecordsSchema } from './sac.schema.js';

const mock = vi.hoisted(() => ({ findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn(), owners: vi.fn(), reasons: vi.fn(), queryRaw: vi.fn() }));
vi.mock('../../lib/prisma.js', () => ({ prisma: {
  sacRecord: { findMany: mock.findMany, count: mock.count, groupBy: mock.groupBy },
  user: { findMany: mock.owners }, reason: { findMany: mock.reasons },
  $queryRaw: mock.queryRaw,
  $transaction: (queries: unknown[]) => Promise.all(queries),
} }));
import { listSacRecords } from './sac.service.js';

describe('server record listing (isolated, no database writes)', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mock.findMany.mockResolvedValue([]); mock.count.mockResolvedValue(0);
    mock.groupBy.mockResolvedValue([]); mock.owners.mockResolvedValue([]); mock.reasons.mockResolvedValue([]); mock.queryRaw.mockResolvedValue([]);
  });
  it('keeps the existing defaults and validates limits and periods', () => {
    expect(listSacRecordsSchema.parse({})).toMatchObject({ page: 1, pageSize: 20, sort: 'updatedAt', order: 'desc' });
    expect(listSacRecordsSchema.safeParse({ pageSize: 101 }).success).toBe(false);
    expect(listSacRecordsSchema.safeParse({ openedFrom: '2026-09-15T00:00:00Z', openedTo: '2026-09-12T00:00:00Z' }).success).toBe(false);
  });
  it('queries past the first 100 records with stable server sorting', async () => {
    mock.findMany.mockResolvedValue([{ id: '101', ticket: 'TEST-101', status: 'PENDING', priority: 'MEDIUM', dueAt: new Date('2026-09-20T12:00:00Z'), openedAt: new Date('2026-09-01T12:00:00Z'), assigneeId: 'user', lastOperationalActivityAt: new Date('2026-09-12T12:00:00Z') }]); mock.count.mockResolvedValue(121);
    const result = await listSacRecords(listSacRecordsSchema.parse({ page: 6, pageSize: 20, sort: 'customer', order: 'asc' }), new Date('2026-09-14T15:00:00Z'));
    expect(mock.findMany.mock.calls[0][0]).toMatchObject({ skip: 100, take: 20, orderBy: [{ customer: { name: 'asc' } }, { id: 'asc' }] });
    expect(result).toMatchObject({ items: [{ ticket: 'TEST-101', operational: { isOverdue: false } }], total: 121, page: 6 });
  });
  it('applies combined filters and reason search before pagination and count', async () => {
    await listSacRecords(listSacRecordsSchema.parse({ query: 'avaria', priority: 'HIGH', status: 'PENDING', reason: 'Avaria', unassigned: 'true', overdueBefore: '2026-09-12T03:00:00Z' }));
    const where = mock.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ priority: 'HIGH', status: 'PENDING', reason: { name: 'Avaria' }, assigneeId: null });
    expect(where.OR).toContainEqual({ reason: { name: { contains: 'avaria', mode: 'insensitive' } } });
    expect(where.AND).toContainEqual({ status: { in: ['PENDING', 'IN_PROGRESS'] }, dueAt: { lt: '2026-09-12T03:00:00Z' } });
    expect(mock.count.mock.calls[0][0]).toEqual({ where });
  });
  it('returns empty items and real zero totals without fabricated pages', async () => {
    expect(await listSacRecords(listSacRecordsSchema.parse({}))).toMatchObject({ items: [], total: 0 });
  });
  it('uses database-side attention ordering with exact page ids', async () => {
    mock.queryRaw.mockResolvedValue([{ id: 'urgent' }]);
    mock.findMany.mockResolvedValue([{ id: 'urgent', ticket: 'TEST-URGENT', status: 'PENDING', priority: 'HIGH', dueAt: new Date('2026-09-13T12:00:00Z'), openedAt: new Date('2026-09-01T12:00:00Z'), assigneeId: null, lastOperationalActivityAt: new Date('2026-09-01T12:00:00Z') }]);
    const result = await listSacRecords(listSacRecordsSchema.parse({ attention: 'required', sort: 'attention', page: 3, pageSize: 5 }), new Date('2026-09-14T15:00:00Z'));
    expect(mock.queryRaw).toHaveBeenCalledOnce();
    expect(mock.findMany.mock.calls[0][0]).toMatchObject({ where: { id: { in: ['urgent'] } } });
    expect(result.items[0]).toMatchObject({ id: 'urgent', operational: { isOverdue: true, isUnassigned: true, isStale: true } });
  });
  it('returns operational counters from the same centralized boundaries', async () => {
    [42, 3, 4, 5, 6, 7, 8].forEach(value => mock.count.mockResolvedValueOnce(value));
    const result = await listSacRecords(listSacRecordsSchema.parse({}), new Date('2026-09-14T15:00:00Z'));
    expect(result).toMatchObject({ total: 42, counts: { overdue: 3, dueToday: 4, nearDue: 5, stale: 6, unassigned: 7, attention: 8, noDue: 0 } });
    expect(mock.count.mock.calls[1][0].where.dueAt.lt).toEqual(mock.count.mock.calls[2][0].where.dueAt.gte);
  });
});
