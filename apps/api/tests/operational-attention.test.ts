import { describe, expect, it } from 'vitest';
import { civilDayNumber, classifyOperationalAttention, compareAttention, operationalBoundaries, zonedDayStart } from '../src/domain/operational-attention.js';

const now = new Date('2026-09-14T15:00:00.000Z');
const record = (overrides: Partial<{ status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'; priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; dueAt: Date | null; assigneeId: string | null; lastOperationalActivityAt: Date; openedAt: Date }> = {}) => ({
  status: 'PENDING' as const, priority: 'MEDIUM' as const, dueAt: new Date('2026-09-20T15:00:00.000Z'), assigneeId: 'user-1', lastOperationalActivityAt: now, openedAt: new Date('2026-09-01T15:00:00.000Z'), ...overrides,
});

describe('operational attention rules', () => {
  it.each([
    ['overdue', new Date('2026-09-13T15:00:00.000Z'), { isOverdue: true, overdueDays: 1, dueState: 'OVERDUE' }],
    ['today', new Date('2026-09-14T23:30:00.000Z'), { isDueToday: true, dueState: 'DUE_TODAY' }],
    ['near tomorrow', new Date('2026-09-15T15:00:00.000Z'), { isNearDue: true, dueState: 'NEAR_DUE' }],
    ['near in two days', new Date('2026-09-16T15:00:00.000Z'), { isNearDue: true, dueState: 'NEAR_DUE' }],
    ['within due', new Date('2026-09-17T15:00:00.000Z'), { isNearDue: false, dueState: 'WITHIN_DUE' }],
  ])('classifies %s by civil day in America/Sao_Paulo', (_label, dueAt, expected) => {
    expect(classifyOperationalAttention(record({ dueAt }), now)).toMatchObject(expected);
  });

  it('uses exactly 72 elapsed hours for stale and preserves reason order', () => {
    const result = classifyOperationalAttention(record({ dueAt: new Date('2026-09-13T15:00:00Z'), priority: 'CRITICAL', assigneeId: null, lastOperationalActivityAt: new Date(now.getTime() - 72 * 60 * 60 * 1000) }), now);
    expect(result).toMatchObject({ isStale: true, staleDays: 3, isUnassigned: true });
    expect(result.attentionReasons).toEqual(['OVERDUE', 'HIGH_PRIORITY', 'UNASSIGNED', 'STALE']);
    expect(classifyOperationalAttention(record({ lastOperationalActivityAt: new Date(now.getTime() - (72 * 60 * 60 * 1000 - 1)) }), now).isStale).toBe(false);
  });

  it('does not flag closed cases and supports the no-due domain state', () => {
    expect(classifyOperationalAttention(record({ status: 'COMPLETED', dueAt: new Date('2026-09-01T15:00:00Z'), assigneeId: null }), now)).toMatchObject({ dueState: 'CLOSED', attentionReasons: [] });
    expect(classifyOperationalAttention(record({ dueAt: null }), now)).toMatchObject({ dueState: 'NO_DUE', attentionReasons: ['NO_DUE'] });
  });

  it('reclassifies a reopened case from its current open status', () => {
    const reopened = classifyOperationalAttention(record({ status: 'IN_PROGRESS', dueAt: new Date('2026-09-13T15:00:00Z') }), now);
    expect(reopened).toMatchObject({ isOverdue: true, dueState: 'OVERDUE' });
  });

  it('orders overdue, today, near, priority, unassigned, stale, due and oldest', () => {
    const items = [
      record({ dueAt: new Date('2026-09-16T15:00:00Z') }),
      record({ dueAt: new Date('2026-09-14T15:00:00Z') }),
      record({ dueAt: new Date('2026-09-13T15:00:00Z') }),
    ];
    expect(items.sort((left, right) => compareAttention(left, right, now)).map(item => civilDayNumber(item.dueAt!))).toEqual([civilDayNumber(items[0].dueAt!), civilDayNumber(items[1].dueAt!), civilDayNumber(items[2].dueAt!)].sort((a, b) => a - b));
  });

  it('handles month/year boundaries and historical daylight-saving transitions', () => {
    expect(civilDayNumber(new Date('2027-01-01T02:30:00Z'))).toBe(civilDayNumber(new Date('2026-12-31T15:00:00Z')));
    const nov4 = zonedDayStart(civilDayNumber(new Date('2018-11-04T15:00:00Z')));
    const nov5 = zonedDayStart(civilDayNumber(new Date('2018-11-05T15:00:00Z')));
    expect(nov5.getTime() - nov4.getTime()).toBe(23 * 60 * 60 * 1000);
    const boundaries = operationalBoundaries(new Date('2018-11-04T15:00:00Z'));
    expect(civilDayNumber(boundaries.todayStart)).toBe(civilDayNumber(new Date('2018-11-04T15:00:00Z')));
  });
});
