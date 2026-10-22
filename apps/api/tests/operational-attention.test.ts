import { describe, expect, it } from 'vitest';
import { civilDayNumber, classifyOperationalAttention, compareAttention, operationalBoundaries, zonedDayStart } from '../src/domain/operational-attention.js';

const now = new Date('2026-09-14T15:00:00.000Z');
const record = (overrides: Partial<{ status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'; priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; dueAt: Date | null; assigneeId: string | null; lastOperationalActivityAt: Date; openedAt: Date; createdAt?: Date; completedAt?: Date | null; updatedAt?: Date }> = {}) => ({
  status: 'PENDING' as const, priority: 'MEDIUM' as const, dueAt: new Date('2026-09-20T15:00:00.000Z'), assigneeId: 'user-1', lastOperationalActivityAt: now, openedAt: new Date('2026-09-01T15:00:00.000Z'), createdAt: new Date('2026-09-01T15:00:00.000Z'), ...overrides,
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

  describe('openDays calculation', () => {
    const referenceNow = new Date('2026-10-06T19:00:00.000Z');

    it('returns 0 days for an old document imported today', () => {
      // Historical occurrence is 47 days ago, but created today
      const imported = record({
        openedAt: new Date('2026-08-20T16:51:00.000Z'),
        createdAt: new Date('2026-10-06T18:58:26.645Z'),
        status: 'PENDING',
      });
      const classified = classifyOperationalAttention(imported, referenceNow);
      expect(classified.openDays).toBe(0);
    });

    it('returns 0 days for a manual record created today', () => {
      const manual = record({
        openedAt: new Date('2026-10-06T14:00:00.000Z'),
        createdAt: new Date('2026-10-06T14:00:00.000Z'),
        status: 'PENDING',
      });
      const classified = classifyOperationalAttention(manual, referenceNow);
      expect(classified.openDays).toBe(0);
    });

    it('returns elapsed civil days for open cases', () => {
      const openCase = record({
        createdAt: new Date('2026-09-26T15:00:00.000Z'),
        status: 'IN_PROGRESS',
      });
      const classified = classifyOperationalAttention(openCase, referenceNow);
      expect(classified.openDays).toBe(10);
    });

    it('calculates duration until closure date for completed cases', () => {
      const closedCase = record({
        createdAt: new Date('2026-10-01T10:00:00.000Z'),
        completedAt: new Date('2026-10-04T12:00:00.000Z'),
        status: 'COMPLETED',
      });
      const classified = classifyOperationalAttention(closedCase, referenceNow);
      expect(classified.openDays).toBe(3);
    });

    it('calculates duration until closure date for cancelled cases', () => {
      const cancelledCase = record({
        createdAt: new Date('2026-10-01T10:00:00.000Z'),
        completedAt: new Date('2026-10-03T12:00:00.000Z'),
        status: 'CANCELLED',
      });
      const classified = classifyOperationalAttention(cancelledCase, referenceNow);
      expect(classified.openDays).toBe(2);
    });

    it('calculates until now when a case is reopened', () => {
      const reopenedCase = record({
        createdAt: new Date('2026-10-01T10:00:00.000Z'),
        completedAt: null,
        status: 'IN_PROGRESS',
      });
      const classified = classifyOperationalAttention(reopenedCase, referenceNow);
      expect(classified.openDays).toBe(5);
    });

    it('calculates duration for closed case without completedAt using reliable historical event', () => {
      // Caso encerrado sem completedAt, com evento confiável no histórico
      const legacyClosed = record({
        createdAt: new Date('2026-09-28T16:30:00.000Z'),
        completedAt: null,
        status: 'CANCELLED',
      });
      (legacyClosed as any).activities = [
        { eventType: 'CREATED', createdAt: new Date('2026-09-28T16:30:00.000Z') },
        { eventType: 'CANCELLED', createdAt: new Date('2026-10-05T20:00:00.000Z') },
      ];
      const classified = classifyOperationalAttention(legacyClosed, referenceNow);
      expect(classified.openDays).toBe(7);
    });

    it('preserves duration when case is edited after closure (updatedAt does not alter duration)', () => {
      // Edição posterior ao encerramento sem alteração da duração
      const closedAt = new Date('2026-10-04T12:00:00.000Z');
      const closedCase = record({
        createdAt: new Date('2026-10-01T10:00:00.000Z'),
        completedAt: closedAt,
        status: 'COMPLETED',
        updatedAt: closedAt,
      });
      const initial = classifyOperationalAttention(closedCase, referenceNow);
      expect(initial.openDays).toBe(3);

      // Editing sector, description, etc. 10 days later updates updatedAt to 2026-10-14
      const editedAfterClosure = {
        ...closedCase,
        updatedAt: new Date('2026-10-14T15:00:00.000Z'),
        lastOperationalActivityAt: new Date('2026-10-14T15:00:00.000Z'),
      };
      const afterEdit = classifyOperationalAttention(editedAfterClosure, referenceNow);
      expect(afterEdit.openDays).toBe(3); // strictly unaltered!
    });

    it('returns null openDays (duration unavailable) when closed case has no reliable date or event', () => {
      // Caso sem data ou evento confiável
      const legacyWithoutEvidence = record({
        createdAt: new Date('2026-10-01T10:00:00.000Z'),
        completedAt: null,
        status: 'COMPLETED',
      });
      (legacyWithoutEvidence as any).activities = [
        { eventType: 'CREATED', createdAt: new Date('2026-10-01T10:00:00.000Z') },
        { eventType: 'UPDATED', createdAt: new Date('2026-10-03T10:00:00.000Z') },
      ];
      const classified = classifyOperationalAttention(legacyWithoutEvidence, referenceNow);
      expect(classified.openDays).toBeNull();
    });

    it('handles cancellation, reopening, and new closure correctly in current cycle', () => {
      // Cancelamento, reabertura e novo encerramento
      const fullLifecycle = record({
        createdAt: new Date('2026-10-01T10:00:00.000Z'),
        completedAt: null,
        status: 'COMPLETED',
      });
      (fullLifecycle as any).activities = [
        { eventType: 'CREATED', createdAt: new Date('2026-10-01T10:00:00.000Z') },
        { eventType: 'CANCELLED', createdAt: new Date('2026-10-03T10:00:00.000Z') },
        { eventType: 'REACTIVATED', createdAt: new Date('2026-10-04T10:00:00.000Z') },
        { eventType: 'COMPLETED', createdAt: new Date('2026-10-06T10:00:00.000Z') },
      ];
      const classified = classifyOperationalAttention(fullLifecycle, referenceNow);
      expect(classified.openDays).toBe(5);
    });

    it('correctly calculates civil days across America/Sao_Paulo boundary', () => {
      // Limites de data no fuso America/Sao_Paulo (UTC-3)
      // 2026-10-03 23:30 BRT = 2026-10-04 02:30 UTC
      // 2026-10-04 00:30 BRT = 2026-10-04 03:30 UTC
      // Same UTC date, but consecutive BRT civil days => exactly 1 day
      const boundaryCase = record({
        createdAt: new Date('2026-10-04T02:30:00.000Z'),
        completedAt: new Date('2026-10-04T03:30:00.000Z'),
        status: 'COMPLETED',
      });
      const classified = classifyOperationalAttention(boundaryCase, referenceNow);
      expect(classified.openDays).toBe(1);

      // Same civil day in BRT (01:00 BRT to 23:00 BRT) => 0 days
      const sameDayBrt = record({
        createdAt: new Date('2026-10-03T04:00:00.000Z'),
        completedAt: new Date('2026-10-04T02:00:00.000Z'),
        status: 'COMPLETED',
      });
      expect(classifyOperationalAttention(sameDayBrt, referenceNow).openDays).toBe(0);
    });
  });
});
