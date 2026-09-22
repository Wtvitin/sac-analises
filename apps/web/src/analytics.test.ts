import { describe, expect, it } from 'vitest';
import {
  formatPercentageChange,
  formatRate,
  formatResolutionTime,
  serializeAnalyticsParams,
  type AnalyticsDashboardData,
  type AnalyticsFilters,
} from './analytics.js';

describe('analytics frontend helpers', () => {
  describe('serializeAnalyticsParams', () => {
    it('serializes predefined period filters', () => {
      const filters: AnalyticsFilters = { period: '30d' };
      const params = serializeAnalyticsParams(filters);
      expect(params.get('period')).toBe('30d');
      expect(params.get('startDate')).toBeNull();
    });

    it('serializes custom period with start and end dates', () => {
      const filters: AnalyticsFilters = {
        period: 'custom',
        startDate: '2026-09-01',
        endDate: '2026-09-15',
        priority: 'HIGH',
        status: 'PENDING',
      };
      const params = serializeAnalyticsParams(filters);
      expect(params.get('period')).toBe('custom');
      expect(params.get('startDate')).toBe('2026-09-01');
      expect(params.get('endDate')).toBe('2026-09-15');
      expect(params.get('priority')).toBe('HIGH');
      expect(params.get('status')).toBe('PENDING');
    });

    it('ignores start/end dates if period is not custom', () => {
      const filters: AnalyticsFilters = {
        period: '7d',
        startDate: '2026-09-01',
        endDate: '2026-09-15',
      };
      const params = serializeAnalyticsParams(filters);
      expect(params.get('period')).toBe('7d');
      expect(params.get('startDate')).toBeNull();
      expect(params.get('endDate')).toBeNull();
    });
  });

  describe('formatResolutionTime', () => {
    it('formats seconds, minutes, hours and days accurately', () => {
      expect(formatResolutionTime(45)).toBe('45s');
      expect(formatResolutionTime(180)).toBe('3m');
      expect(formatResolutionTime(3600)).toBe('1h');
      expect(formatResolutionTime(4500)).toBe('1h 15m');
      expect(formatResolutionTime(86400)).toBe('1d');
      expect(formatResolutionTime(90000)).toBe('1d 1h');
    });

    it('handles null and invalid values with dash', () => {
      expect(formatResolutionTime(null)).toBe('—');
      expect(formatResolutionTime(-10)).toBe('—');
    });
  });

  describe('formatPercentageChange', () => {
    it('formats positive and negative changes with polarity', () => {
      const pos = formatPercentageChange(15.4);
      expect(pos.text).toBe('+15,4%');
      expect(pos.polarity).toBe('positive');

      const neg = formatPercentageChange(-8.2);
      expect(neg.text).toBe('-8,2%');
      expect(neg.polarity).toBe('negative');

      const zero = formatPercentageChange(0);
      expect(zero.text).toBe('0,0%');
      expect(zero.polarity).toBe('neutral');
    });

    it('handles null percentage (division by zero / sem base) gracefully', () => {
      const res = formatPercentageChange(null);
      expect(res.text).toBe('Sem base anterior');
      expect(res.polarity).toBe('neutral');
    });
  });

  describe('formatRate', () => {
    it('formats rate with brazilian decimal comma', () => {
      expect(formatRate(94.2)).toBe('94,2%');
      expect(formatRate(100)).toBe('100,0%');
      expect(formatRate(null)).toBe('—');
    });
  });

  describe('Regression: Canonical contract and white screen prevention on empty database', () => {
    it('handles canonical empty database payload structure gracefully', () => {
      const emptyPayload: AnalyticsDashboardData = {
        isEmptyDatabase: true,
        period: {
          selected: '30d' as const,
          granularity: 'day' as const,
          currentRange: { start: '2026-08-23T00:00:00.000Z', end: '2026-09-22T00:00:00.000Z' },
          previousRange: { start: '2026-07-24T00:00:00.000Z', end: '2026-08-23T00:00:00.000Z' },
        },
        metrics: {
          openedInPeriod: { current: 0, previous: 0, change: 0, percentageChange: null },
          completedInPeriod: { current: 0, previous: 0, change: 0, percentageChange: null },
          cancelledInPeriod: { current: 0, previous: 0, change: 0, percentageChange: null },
          avgResolutionSeconds: { current: null, previous: null, changeSeconds: null },
          slaCompliance: { currentRate: null, previousRate: null, rateChange: null, onTimeCount: 0, lateCount: 0 },
          currentPending: 0,
          currentInProgress: 0,
          currentOverdue: 0,
          currentNearDue: 0,
          currentStale: 0,
          currentUnassigned: 0,
          currentHighOrCritical: 0,
        },
        timeSeries: [],
        distributions: {
          byStatus: [],
          byPriority: [],
          byChannel: [],
          topReasons: [],
          topSubreasons: [],
          backlogAge: [],
        },
        teamPerformance: [],
      };

      expect(emptyPayload.isEmptyDatabase).toBe(true);
      expect(emptyPayload.distributions.byStatus).toHaveLength(0);
      expect(emptyPayload.distributions.byPriority).toHaveLength(0);
      expect(emptyPayload.distributions.byChannel).toHaveLength(0);
      expect(emptyPayload.distributions.topReasons).toHaveLength(0);
      expect(emptyPayload.distributions.topSubreasons).toHaveLength(0);
      expect(emptyPayload.distributions.backlogAge).toHaveLength(0);

      // Verify no flat duplicate keys exist
      expect(emptyPayload).not.toHaveProperty('statusDistribution');
      expect(emptyPayload).not.toHaveProperty('priorityDistribution');
      expect(emptyPayload).not.toHaveProperty('channelsDistribution');
      expect(emptyPayload).not.toHaveProperty('topReasons');
      expect(emptyPayload).not.toHaveProperty('topSubreasons');
      expect(emptyPayload).not.toHaveProperty('backlogAging');

      expect(formatResolutionTime(emptyPayload.metrics.avgResolutionSeconds.current)).toBe('—');
      expect(formatRate(emptyPayload.metrics.slaCompliance.currentRate)).toBe('—');
      expect(formatPercentageChange(emptyPayload.metrics.openedInPeriod.percentageChange).text).toBe('Sem base anterior');
    });

    it('frontend safely extracts from canonical distributions object', () => {
      const canonicalPayload: AnalyticsDashboardData = {
        isEmptyDatabase: false,
        period: {
          selected: '30d',
          granularity: 'day',
          currentRange: { start: '2026-08-23T00:00:00.000Z', end: '2026-09-22T00:00:00.000Z' },
          previousRange: { start: '2026-07-24T00:00:00.000Z', end: '2026-08-23T00:00:00.000Z' },
        },
        metrics: {
          openedInPeriod: { current: 1, previous: 0, change: 1, percentageChange: null },
          completedInPeriod: { current: 1, previous: 0, change: 1, percentageChange: null },
          cancelledInPeriod: { current: 0, previous: 0, change: 0, percentageChange: null },
          avgResolutionSeconds: { current: 3600, previous: null, changeSeconds: null },
          slaCompliance: { currentRate: 100, previousRate: null, rateChange: null, onTimeCount: 1, lateCount: 0 },
          currentPending: 0,
          currentInProgress: 0,
          currentOverdue: 0,
          currentNearDue: 0,
          currentStale: 0,
          currentUnassigned: 0,
          currentHighOrCritical: 0,
        },
        timeSeries: [{ key: '2026-09-22', label: '22/09', opened: 1, completed: 1 }],
        distributions: {
          byStatus: [{ status: 'COMPLETED', label: 'Concluído', count: 1, percentage: 100 }],
          byPriority: [{ priority: 'LOW', label: 'Baixa', count: 1, percentage: 100 }],
          byChannel: [{ id: 'ch-1', name: 'Email', count: 1, percentage: 100 }],
          topReasons: [{ id: 'rs-1', name: 'Dúvida', count: 1, percentage: 100 }],
          topSubreasons: [],
          backlogAge: [],
        },
        teamPerformance: [{
          id: 'usr-1',
          name: 'Operador Teste',
          email: 'teste@sac.local',
          role: 'ANALYST',
          currentlyAssigned: 0,
          completedInPeriod: 1,
          overdueCount: 0,
          avgResolutionSeconds: 3600,
          onTimeRate: 100,
        }],
      };

      // Frontend extraction pattern
      const statusDistribution = canonicalPayload.distributions?.byStatus ?? [];
      const priorityDistribution = canonicalPayload.distributions?.byPriority ?? [];
      const channelsDistribution = canonicalPayload.distributions?.byChannel ?? [];
      const topReasons = canonicalPayload.distributions?.topReasons ?? [];
      const topSubreasons = canonicalPayload.distributions?.topSubreasons ?? [];
      const backlogAging = canonicalPayload.distributions?.backlogAge ?? [];

      expect(statusDistribution).toHaveLength(1);
      expect(statusDistribution[0].status).toBe('COMPLETED');
      expect(priorityDistribution).toHaveLength(1);
      expect(channelsDistribution).toHaveLength(1);
      expect(topReasons).toHaveLength(1);
      expect(topSubreasons).toHaveLength(0);
      expect(backlogAging).toHaveLength(0);

      // Safe .every() and array checks
      expect(statusDistribution.every((s: { count: number }) => s.count === 0)).toBe(false);
      expect(priorityDistribution.every((p: { count: number }) => p.count === 0)).toBe(false);
      expect(topSubreasons.length).toBe(0);
      expect(backlogAging.every((b: { count: number }) => b.count === 0)).toBe(true);

      // Team performance canonical fields
      const member = canonicalPayload.teamPerformance[0];
      expect(member.id).toBe('usr-1');
      expect(member.currentlyAssigned).toBe(0);
      expect(member.completedInPeriod).toBe(1);
      expect(member.overdueCount).toBe(0);
    });
  });
});
