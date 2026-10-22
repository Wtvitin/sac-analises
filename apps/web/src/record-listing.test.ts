import { describe, expect, it } from 'vitest';
import type { RecordItem } from './data';
import {
  EMPTY_RECORD_FILTERS, calculateOpenDays, filterRecords, getDueLabel, getOpenDuration, paginateRecords,
  recordListParams, sortRecords,
} from './record-listing';

const makeRecord = (overrides: Partial<RecordItem>): RecordItem => ({
  ticket: 'SAC-2026-0001', customer: 'Cliente Alfa', order: '1001', occurrence: 'Avaria', owner: 'Sem responsável',
  status: 'Pendente', due: '15/09/2026', updated: '12/09/2026, 10:30:00', openedAt: '10/09/2026, 09:00:00',
  priority: 'Média', description: 'Descrição válida do registro.', operational: { isOverdue: false, isDueToday: false, isNearDue: false, isStale: false, isUnassigned: true, attentionReasons: ['UNASSIGNED'], dueState: 'WITHIN_DUE', overdueDays: 0, staleDays: 0, lastOperationalActivityAt: '2026-09-12T13:30:00.000Z' }, ...overrides,
});

describe('record listing helpers', () => {
  it('sends server search, filters and sorting for any page', () => {
    const params = recordListParams('avaria', { ...EMPTY_RECORD_FILTERS, priority: 'Alta', attention: 'Sem responsável', startDate: '2026-09-01', endDate: '2026-09-12' }, 'customer', 'asc', 6, 20);
    expect(Object.fromEntries(params)).toMatchObject({ query: 'avaria', priority: 'HIGH', attention: 'unassigned', sort: 'customer', page: '6', pageSize: '20', order: 'asc' });
    expect(new Date(params.get('openedTo')!).getDate()).toBe(13);
    expect(recordListParams('', EMPTY_RECORD_FILTERS, 'default', 'asc', 1, 20).get('order')).toBe('desc');
  });

  it('clamps a removed last page and supports a single page', () => {
    expect(paginateRecords([1, 2], 9, 20)).toMatchObject({ items: [1, 2], page: 1, totalPages: 1 });
  });

  it('combines query and filters without losing reason matches', () => {
    const records = [makeRecord({}), makeRecord({ ticket: 'SAC-2026-0002', customer: 'Cliente Beta', occurrence: 'Extravio', priority: 'Alta' })];
    const result = filterRecords(records, 'extravio', { ...EMPTY_RECORD_FILTERS, priority: 'Alta' });
    expect(result.map(record => record.ticket)).toEqual(['SAC-2026-0002']);
  });

  it('prioritizes overdue and higher priority by default', () => {
    const records = [makeRecord({ ticket: 'B', due: '18/09/2026', priority: 'Baixa' }), makeRecord({ ticket: 'A', due: '10/09/2026', priority: 'Crítica', operational: { ...makeRecord({}).operational, isOverdue: true, overdueDays: 2, dueState: 'OVERDUE', attentionReasons: ['OVERDUE', 'HIGH_PRIORITY'] } })];
    expect(sortRecords(records, 'default', 'asc')[0].ticket).toBe('A');
  });

  it('returns correct empty and multi-page pagination', () => {
    expect(paginateRecords([], 1, 20)).toMatchObject({ items: [], total: 0, totalPages: 1 });
    expect(paginateRecords(Array.from({ length: 25 }, (_, index) => makeRecord({ ticket: String(index) })), 2, 20)).toMatchObject({ page: 2, total: 25, totalPages: 2 });
  });

  it('filters by specific department and unassigned (Sem setor definido)', () => {
    const r1 = makeRecord({ ticket: 'SAC-1', department: 'Estoque' });
    const r2 = makeRecord({ ticket: 'SAC-2', department: 'Qualidade' });
    const r3 = makeRecord({ ticket: 'SAC-3', department: null });

    const all = [r1, r2, r3];
    expect(filterRecords(all, '', { ...EMPTY_RECORD_FILTERS, department: 'Estoque' }).map(r => r.ticket)).toEqual(['SAC-1']);
    expect(filterRecords(all, '', { ...EMPTY_RECORD_FILTERS, department: 'unassigned' }).map(r => r.ticket)).toEqual(['SAC-3']);
    expect(filterRecords(all, '', { ...EMPTY_RECORD_FILTERS, department: 'Sem setor definido' }).map(r => r.ticket)).toEqual(['SAC-3']);
  });

  describe('calculateOpenDays and getOpenDuration', () => {
    const testNow = new Date('2026-10-06T15:00:00.000Z');

    it('returns "Hoje" and 0 days for an old document imported today', () => {
      // Historical occurrence date from 47 days ago, but created in system today
      const importedRecord = makeRecord({
        ticket: 'SAC-2026-0011',
        openedAt: '20/08/2026, 16:51:00',
        createdAt: '2026-10-06T12:00:00.000Z',
        status: 'Pendente',
      });
      expect(calculateOpenDays(importedRecord, testNow)).toBe(0);
      expect(getOpenDuration(importedRecord, testNow)).toBe('Hoje');
    });

    it('returns "Hoje" and 0 days for a manual record created today', () => {
      const manualRecord = makeRecord({
        ticket: 'SAC-2026-0012',
        openedAt: '06/10/2026, 14:00:00',
        createdAt: '2026-10-06T14:00:00.000Z',
        status: 'Pendente',
      });
      expect(calculateOpenDays(manualRecord, testNow)).toBe(0);
      expect(getOpenDuration(manualRecord, testNow)).toBe('Hoje');
    });

    it('returns civil days for an open record created in the past', () => {
      const pastRecord = makeRecord({
        ticket: 'SAC-2026-0005',
        createdAt: '2026-09-26T15:00:00.000Z',
        status: 'Em andamento',
      });
      expect(calculateOpenDays(pastRecord, testNow)).toBe(10);
      expect(getOpenDuration(pastRecord, testNow)).toBe('10 dias');

      const oneDayRecord = makeRecord({
        ticket: 'SAC-2026-0009',
        createdAt: '2026-10-05T15:00:00.000Z',
        status: 'Pendente',
      });
      expect(calculateOpenDays(oneDayRecord, testNow)).toBe(1);
      expect(getOpenDuration(oneDayRecord, testNow)).toBe('1 dia');
    });

    it('calculates duration until closure date for completed and cancelled cases', () => {
      const completedRecord = makeRecord({
        ticket: 'SAC-2026-0003',
        createdAt: '2026-10-01T10:00:00.000Z',
        completedAt: '2026-10-04T12:00:00.000Z',
        status: 'Concluído',
      });
      expect(calculateOpenDays(completedRecord, testNow)).toBe(3);
      expect(getOpenDuration(completedRecord, testNow)).toBe('3 dias');

      const cancelledRecord = makeRecord({
        ticket: 'SAC-2026-0004',
        createdAt: '2026-10-01T10:00:00.000Z',
        completedAt: '2026-10-03T18:00:00.000Z',
        status: 'Cancelado',
      });
      expect(calculateOpenDays(cancelledRecord, testNow)).toBe(2);
      expect(getOpenDuration(cancelledRecord, testNow)).toBe('2 dias');
    });

    it('calculates until current time for reopened cases', () => {
      const reopenedRecord = makeRecord({
        ticket: 'SAC-2026-0006',
        createdAt: '2026-10-01T10:00:00.000Z',
        completedAt: null, // cleared upon reopening
        status: 'Em andamento',
      });
      expect(calculateOpenDays(reopenedRecord, testNow)).toBe(5);
      expect(getOpenDuration(reopenedRecord, testNow)).toBe('5 dias');
    });

    it('respects America/Sao_Paulo civil day boundaries', () => {
      // 2026-10-06 22:00 BRT is 2026-10-07 01:00 UTC
      const lateBrt = new Date('2026-10-07T01:00:00.000Z');
      const earlyBrt = new Date('2026-10-06T10:00:00.000Z');
      const recordSameBrtDay = {
        createdAt: earlyBrt,
      };
      expect(calculateOpenDays(recordSameBrtDay, lateBrt)).toBe(0);
      expect(getOpenDuration(recordSameBrtDay, lateBrt)).toBe('Hoje');
    });

    it('calculates duration for closed case without completedAt using reliable historical event', () => {
      // Caso encerrado sem completedAt, com evento confiável no histórico
      const legacyRecord = makeRecord({
        ticket: 'SAC-2026-0009',
        createdAt: '2026-09-28T16:30:00.000Z',
        completedAt: null,
        status: 'Cancelado',
      });
      (legacyRecord as any).activities = [
        { eventType: 'CREATED', createdAt: '2026-09-28T16:30:00.000Z' },
        { eventType: 'CANCELLED', createdAt: '2026-10-05T20:00:00.000Z' },
      ];
      expect(calculateOpenDays(legacyRecord, testNow)).toBe(7);
      expect(getOpenDuration(legacyRecord, testNow)).toBe('7 dias');
    });

    it('preserves duration when closed case is edited afterwards without altering duration', () => {
      // Edição posterior ao encerramento sem alteração da duração
      const closedRecord = makeRecord({
        ticket: 'SAC-2026-0001',
        createdAt: '2026-10-01T10:00:00.000Z',
        completedAt: '2026-10-04T12:00:00.000Z',
        updatedAt: '2026-10-04T12:00:00.000Z',
        status: 'Concluído',
      });
      expect(getOpenDuration(closedRecord, testNow)).toBe('3 dias');

      // Subsequent edit 10 days later
      const editedRecord = {
        ...closedRecord,
        department: 'Financeiro',
        description: 'Descrição atualizada pós encerramento',
        updatedAt: '2026-10-14T10:00:00.000Z',
      };
      expect(calculateOpenDays(editedRecord, testNow)).toBe(3);
      expect(getOpenDuration(editedRecord, testNow)).toBe('3 dias');
    });

    it('displays "Duração indisponível" when closed case has no reliable date or event', () => {
      // Caso sem data ou evento confiável
      const unreliablyClosedRecord = makeRecord({
        ticket: 'SAC-2026-0099',
        createdAt: '2026-10-01T10:00:00.000Z',
        completedAt: null,
        status: 'Concluído',
      });
      (unreliablyClosedRecord as any).activities = [
        { eventType: 'CREATED', createdAt: '2026-10-01T10:00:00.000Z' },
        { eventType: 'UPDATED', createdAt: '2026-10-03T10:00:00.000Z' },
      ];
      expect(calculateOpenDays(unreliablyClosedRecord, testNow)).toBeNull();
      expect(getOpenDuration(unreliablyClosedRecord, testNow)).toBe('Duração indisponível');
    });

    it('handles cancellation, reopening, and new closure in current cycle', () => {
      // Cancelamento, reabertura e novo encerramento
      const multiCycleRecord = makeRecord({
        ticket: 'SAC-2026-0088',
        createdAt: '2026-10-01T10:00:00.000Z',
        completedAt: null,
        status: 'Concluído',
      });
      (multiCycleRecord as any).activities = [
        { eventType: 'CREATED', createdAt: '2026-10-01T10:00:00.000Z' },
        { eventType: 'CANCELLED', createdAt: '2026-10-03T10:00:00.000Z' },
        { eventType: 'REACTIVATED', createdAt: '2026-10-04T10:00:00.000Z' },
        { eventType: 'COMPLETED', createdAt: '2026-10-06T10:00:00.000Z' },
      ];
      expect(calculateOpenDays(multiCycleRecord, testNow)).toBe(5);
      expect(getOpenDuration(multiCycleRecord, testNow)).toBe('5 dias');
    });

    it('handles date boundaries in America/Sao_Paulo timezone', () => {
      // Limites de data no fuso America/Sao_Paulo
      // 2026-10-03 23:30 BRT = 2026-10-04 02:30 UTC
      // 2026-10-04 00:30 BRT = 2026-10-04 03:30 UTC
      const boundaryRecord = {
        createdAt: '2026-10-04T02:30:00.000Z',
        completedAt: '2026-10-04T03:30:00.000Z',
        status: 'Concluído',
      };
      expect(calculateOpenDays(boundaryRecord, testNow)).toBe(1);
      expect(getOpenDuration(boundaryRecord, testNow)).toBe('1 dia');
    });
  });
});
