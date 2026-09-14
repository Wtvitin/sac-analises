import { describe, expect, it } from 'vitest';
import type { RecordItem } from './data';
import { EMPTY_RECORD_FILTERS, filterRecords, getDueLabel, paginateRecords, sortRecords, recordListParams } from './record-listing';

const makeRecord = (overrides: Partial<RecordItem>): RecordItem => ({
  ticket: 'SAC-2026-0001', customer: 'Cliente Alfa', order: '1001', occurrence: 'Avaria', owner: 'Sem responsável',
  status: 'Pendente', due: '15/09/2026', updated: '12/09/2026, 10:30:00', openedAt: '10/09/2026, 09:00:00',
  priority: 'Média', description: 'Descrição válida do registro.', ...overrides,
});

describe('record listing helpers', () => {
  const now = new Date(2026, 8, 12, 12);

  it('sends server search, filters and sorting for any page', () => {
    const params = recordListParams('avaria', { ...EMPTY_RECORD_FILTERS, priority: 'Alta', unassigned: true, due: 'Hoje', startDate: '2026-09-01', endDate: '2026-09-12' }, 'customer', 'asc', 6, 20, now);
    expect(Object.fromEntries(params)).toMatchObject({ query: 'avaria', priority: 'HIGH', unassigned: 'true', sort: 'customer', page: '6', pageSize: '20', order: 'asc' });
    expect(new Date(params.get('dueTo')!).getDate()).toBe(13);
    expect(new Date(params.get('openedTo')!).getDate()).toBe(13);
    expect(recordListParams('', EMPTY_RECORD_FILTERS, 'default', 'asc', 1, 20).get('order')).toBe('desc');
  });

  it('clamps a removed last page and supports a single page', () => {
    expect(paginateRecords([1, 2], 9, 20)).toMatchObject({ items: [1, 2], page: 1, totalPages: 1 });
  });

  it('combines query and filters without losing reason matches', () => {
    const records = [makeRecord({}), makeRecord({ ticket: 'SAC-2026-0002', customer: 'Cliente Beta', occurrence: 'Extravio', priority: 'Alta' })];
    const result = filterRecords(records, 'extravio', { ...EMPTY_RECORD_FILTERS, priority: 'Alta' }, now);
    expect(result.map(record => record.ticket)).toEqual(['SAC-2026-0002']);
  });

  it('prioritizes overdue and higher priority by default', () => {
    const records = [makeRecord({ ticket: 'B', due: '18/09/2026', priority: 'Baixa' }), makeRecord({ ticket: 'A', due: '10/09/2026', priority: 'Crítica' })];
    expect(sortRecords(records, 'default', 'asc', now)[0].ticket).toBe('A');
  });

  it('returns correct empty and multi-page pagination', () => {
    expect(paginateRecords([], 1, 20)).toMatchObject({ items: [], total: 0, totalPages: 1 });
    expect(paginateRecords(Array.from({ length: 25 }, (_, index) => makeRecord({ ticket: String(index) })), 2, 20)).toMatchObject({ page: 2, total: 25, totalPages: 2 });
  });

  it('formats relative due labels', () => {
    expect(getDueLabel(makeRecord({ due: '12/09/2026' }), now)).toBe('Vence hoje');
    expect(getDueLabel(makeRecord({ due: '11/09/2026' }), now)).toBe('Atrasado há 1 dia');
  });
});
