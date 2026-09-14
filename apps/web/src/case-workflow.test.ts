import { describe, expect, it } from 'vitest';
import { availableCaseActions, requiresDueDateReason, requiresPriorityReason } from './case-workflow';

describe('ações operacionais do caso', () => {
  it('expõe as ações compatíveis com cada estado', () => {
    expect(availableCaseActions('PENDING', 'ANALYST', false)).toEqual(['take-and-start', 'cancel']);
    expect(availableCaseActions('PENDING', 'ANALYST', true)).toEqual(['start', 'cancel']);
    expect(availableCaseActions('IN_PROGRESS', 'ANALYST', true)).toEqual(['complete', 'cancel']);
    expect(availableCaseActions('COMPLETED', 'ANALYST', true)).toEqual(['reopen']);
    expect(availableCaseActions('CANCELLED', 'ADMIN', true)).toEqual(['reactivate']);
  });
  it('não oferece mutações a consulta nem reativação a analista', () => {
    expect(availableCaseActions('PENDING', 'VIEWER', false)).toEqual([]);
    expect(availableCaseActions('CANCELLED', 'ANALYST', true)).toEqual([]);
  });
  it('identifica justificativas de redução e prorrogação', () => {
    expect(requiresPriorityReason('HIGH', 'MEDIUM')).toBe(true);
    expect(requiresPriorityReason('LOW', 'HIGH')).toBe(false);
    expect(requiresDueDateReason('2026-09-14', '2026-09-15')).toBe(true);
    expect(requiresDueDateReason('2026-09-14', '2026-09-13')).toBe(false);
  });
});
