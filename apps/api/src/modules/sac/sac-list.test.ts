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

  describe('pesquisa por referências e ordenação por atenção', () => {
    it('inclui SacReference na consulta SQL quando sort=attention é utilizado', async () => {
      mock.queryRaw.mockResolvedValue([{ id: 'case-nf' }]);
      mock.findMany.mockResolvedValue([{
        id: 'case-nf',
        ticket: 'SAC-2026-001',
        externalTicket: 'EXT-100',
        orderNumber: 'PED-500',
        status: 'PENDING',
        priority: 'HIGH',
        dueAt: new Date('2026-09-20T12:00:00Z'),
        openedAt: new Date('2026-09-01T12:00:00Z'),
        assigneeId: null,
        lastOperationalActivityAt: new Date('2026-09-01T12:00:00Z'),
        references: [{ id: 'ref-1', type: 'INVOICE', value: 'NF-998877' }],
      }]);
      mock.count.mockResolvedValue(1);

      const result = await listSacRecords(
        listSacRecordsSchema.parse({ query: 'NF-998877', sort: 'attention', page: 1, pageSize: 10 }),
        new Date('2026-09-14T15:00:00Z')
      );

      // Valida que queryRaw foi chamado
      expect(mock.queryRaw).toHaveBeenCalledOnce();
      const rawQuery = mock.queryRaw.mock.calls[0][0];

      // Valida que a consulta SQL gerada contém a cláusula EXISTS para SacReference
      const sqlText = rawQuery.strings.join('?');
      expect(sqlText).toContain('EXISTS (SELECT 1 FROM "SacReference" ref WHERE ref."recordId" = s."id" AND ref."value" ILIKE ?)');
      expect(rawQuery.values).toContain('%NF-998877%');

      // Valida que o registro encontrado foi retornado e o total coincide
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('case-nf');
      expect(result.total).toBe(1);
    });

    it('encontra registro por número do atendimento externo e pedido em ambas as ordenações', async () => {
      mock.queryRaw.mockResolvedValue([{ id: 'case-ext' }]);
      mock.findMany.mockResolvedValue([{
        id: 'case-ext',
        ticket: 'SAC-2026-002',
        externalTicket: 'ATEND-005233',
        orderNumber: 'PED-8877',
        status: 'IN_PROGRESS',
        priority: 'MEDIUM',
        dueAt: new Date('2026-09-25T12:00:00Z'),
        openedAt: new Date('2026-09-01T12:00:00Z'),
        assigneeId: null,
        lastOperationalActivityAt: new Date('2026-09-01T12:00:00Z'),
        references: [],
      }]);
      mock.count.mockResolvedValue(1);

      // 1. Busca por atendimento externo com sort=attention
      const resAttention = await listSacRecords(
        listSacRecordsSchema.parse({ query: '005233', sort: 'attention' }),
        new Date('2026-09-14T15:00:00Z')
      );
      expect(resAttention.items).toHaveLength(1);
      expect(resAttention.items[0].externalTicket).toBe('ATEND-005233');

      // 2. Busca por pedido com ordenação padrão
      mock.findMany.mockResolvedValueOnce([{
        id: 'case-ext',
        ticket: 'SAC-2026-002',
        externalTicket: 'ATEND-005233',
        orderNumber: 'PED-8877',
        status: 'IN_PROGRESS',
        priority: 'MEDIUM',
        dueAt: new Date('2026-09-25T12:00:00Z'),
        openedAt: new Date('2026-09-01T12:00:00Z'),
        assigneeId: null,
        lastOperationalActivityAt: new Date('2026-09-01T12:00:00Z'),
        references: [],
      }]);
      const resDefault = await listSacRecords(
        listSacRecordsSchema.parse({ query: '8877', sort: 'openedAt' }),
        new Date('2026-09-14T15:00:00Z')
      );
      expect(resDefault.items).toHaveLength(1);
      expect(resDefault.items[0].orderNumber).toBe('PED-8877');
    });

    it('não duplica registros quando o caso possui múltiplas referências', async () => {
      // Caso possui 3 referências distintas (NF, Pedido, Protocolo)
      mock.queryRaw.mockResolvedValue([{ id: 'case-multi' }]);
      mock.findMany.mockResolvedValue([{
        id: 'case-multi',
        ticket: 'SAC-2026-003',
        status: 'PENDING',
        priority: 'HIGH',
        dueAt: new Date('2026-09-18T12:00:00Z'),
        openedAt: new Date('2026-09-01T12:00:00Z'),
        assigneeId: null,
        lastOperationalActivityAt: new Date('2026-09-01T12:00:00Z'),
        references: [
          { id: 'ref-1', type: 'INVOICE', value: 'NF-1001' },
          { id: 'ref-2', type: 'ORDER', value: 'PED-2002' },
          { id: 'ref-3', type: 'EXTERNAL_TICKET', value: 'EXT-3003' },
        ],
      }]);
      mock.count.mockResolvedValue(1);

      const result = await listSacRecords(
        listSacRecordsSchema.parse({ query: 'NF', sort: 'attention', page: 1, pageSize: 20 }),
        new Date('2026-09-14T15:00:00Z')
      );

      // Retorna exatamente 1 item único, sem duplicidade
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.items[0].references).toHaveLength(3);
    });

    it('retorna lista vazia e total zero para referências inexistentes sob sort=attention', async () => {
      mock.queryRaw.mockResolvedValue([]);
      mock.findMany.mockResolvedValue([]);
      mock.count.mockResolvedValue(0);

      const result = await listSacRecords(
        listSacRecordsSchema.parse({ query: 'REFERENCIA_INEXISTENTE_XYZ', sort: 'attention' }),
        new Date('2026-09-14T15:00:00Z')
      );

      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('combina busca por referência com filtro de setor, permissões e paginação', async () => {
      mock.queryRaw.mockResolvedValue([{ id: 'case-qualidade' }]);
      mock.findMany.mockResolvedValue([{
        id: 'case-qualidade',
        ticket: 'SAC-2026-004',
        department: 'Qualidade',
        status: 'PENDING',
        priority: 'HIGH',
        dueAt: new Date('2026-09-18T12:00:00Z'),
        openedAt: new Date('2026-09-01T12:00:00Z'),
        assigneeId: null,
        lastOperationalActivityAt: new Date('2026-09-01T12:00:00Z'),
        references: [{ id: 'ref-4', type: 'INVOICE', value: 'NF-QUALIDADE' }],
      }]);
      mock.count.mockResolvedValue(1);

      // Usuário com perfil ANALYST vinculado ao setor 'Qualidade'
      const result = await listSacRecords(
        listSacRecordsSchema.parse({ query: 'QUALIDADE', sort: 'attention', priority: 'HIGH', status: 'PENDING', page: 2, pageSize: 10 }),
        'ANALYST',
        'Qualidade',
        new Date('2026-09-14T15:00:00Z')
      );

      const rawQuery = mock.queryRaw.mock.calls[0][0];
      const sqlText = rawQuery.strings.join('?');

      // Verifica cláusula de setor segregada
      expect(sqlText).toContain('s."department" = ?');
      expect(rawQuery.values).toContain('Qualidade');

      // Verifica cláusula de status e prioridade
      expect(sqlText).toContain('s."status"::text = ?');
      expect(rawQuery.values).toContain('PENDING');
      expect(sqlText).toContain('s."priority"::text = ?');
      expect(rawQuery.values).toContain('HIGH');

      // Verifica OFFSET de paginação (página 2, pageSize 10 -> offset 10)
      expect(sqlText).toContain('LIMIT ? OFFSET ?');
      expect(rawQuery.values).toContain(10); // pageSize e offset

      expect(result.items).toHaveLength(1);
      expect(result.page).toBe(2);
      expect(result.pageSize).toBe(10);
    });
  });
});
