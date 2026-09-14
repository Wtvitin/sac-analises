import { describe, expect, it } from 'vitest';
import { assertCanCancel, assertCanComplete, assertCanReactivate, assertCanReopen, assertStatusTransition, isOverdue, type SacStatus } from '../src/domain/sac-rules.js';

describe('regras de registros SAC', () => {
  it('considera vencido somente o caso aberto após o prazo', () => {
    const now = new Date('2026-09-11T15:00:00Z');
    expect(isOverdue('PENDING', new Date('2026-09-11T14:59:00Z'), now)).toBe(true);
    expect(isOverdue('COMPLETED', new Date('2026-09-10T14:59:00Z'), now)).toBe(false);
  });
  it('exige resumo para conclusão e justificativa para reabertura', () => {
    expect(() => assertCanComplete('')).toThrow(/resumo/i);
    expect(() => assertCanReopen('')).toThrow(/justificativa/i);
    expect(() => assertCanCancel('')).toThrow(/justificativa/i);
    expect(() => assertCanReactivate('')).toThrow(/justificativa/i);
  });
  it.each<[SacStatus, SacStatus]>([
    ['PENDING', 'IN_PROGRESS'], ['PENDING', 'CANCELLED'], ['IN_PROGRESS', 'COMPLETED'],
    ['IN_PROGRESS', 'CANCELLED'], ['COMPLETED', 'IN_PROGRESS'], ['CANCELLED', 'PENDING'],
  ])('permite a transição operacional %s → %s', (from, to) => {
    expect(() => assertStatusTransition(from, to, 'ADMIN')).not.toThrow();
  });
  it.each<[SacStatus, SacStatus]>([
    ['PENDING', 'PENDING'], ['PENDING', 'COMPLETED'], ['IN_PROGRESS', 'PENDING'],
    ['COMPLETED', 'CANCELLED'], ['CANCELLED', 'IN_PROGRESS'],
  ])('rejeita a transição inválida %s → %s', (from, to) => {
    expect(() => assertStatusTransition(from, to, 'ADMIN')).toThrow(/não é permitida/i);
  });
  it('restringe a reativação de cancelado ao administrador', () => {
    expect(() => assertStatusTransition('CANCELLED', 'PENDING', 'ANALYST')).toThrow(/administradores/i);
  });
});
