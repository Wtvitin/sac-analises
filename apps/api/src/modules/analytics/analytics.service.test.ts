import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    sacRecord: { count: vi.fn().mockResolvedValue(0) },
    $queryRaw: vi.fn().mockResolvedValue([]),
  },
}));

import {
  calculateComparison,
  formatDateBr,
  generateBuckets,
  getAnalyticsDashboard,
  resolvePeriodInterval,
  sanitizeCsvField,
  streamAnalyticsCsv,
} from './analytics.service.js';
import { analyticsFilterSchema } from './analytics.schema.js';
import { prisma } from '../../lib/prisma.js';

describe('analytics service logic (isolated)', () => {
  const fixedNow = new Date('2026-09-22T12:00:00.000Z');

  describe('resolvePeriodInterval', () => {
    it('resolves 7d with day granularity', () => {
      const parsed = analyticsFilterSchema.parse({ period: '7d' });
      const interval = resolvePeriodInterval(parsed, fixedNow);
      expect(interval.granularity).toBe('day');
      expect(interval.durationDays).toBe(7);
      expect(interval.currentEnd.getTime()).toBeGreaterThan(interval.currentStart.getTime());
      expect(interval.previousEnd.getTime()).toBe(interval.currentStart.getTime());
      expect(interval.currentStart.getTime() - interval.previousStart.getTime()).toBe(interval.currentEnd.getTime() - interval.currentStart.getTime());
    });

    it('resolves 30d and 90d with week granularity', () => {
      const p30 = resolvePeriodInterval(analyticsFilterSchema.parse({ period: '30d' }), fixedNow);
      expect(p30.granularity).toBe('week');
      expect(p30.durationDays).toBe(30);

      const p90 = resolvePeriodInterval(analyticsFilterSchema.parse({ period: '90d' }), fixedNow);
      expect(p90.granularity).toBe('week');
      expect(p90.durationDays).toBe(90);
    });

    it('resolves 6m and year with month granularity', () => {
      const p6m = resolvePeriodInterval(analyticsFilterSchema.parse({ period: '6m' }), fixedNow);
      expect(p6m.granularity).toBe('month');
      expect(p6m.durationDays).toBeGreaterThan(90);

      const pYear = resolvePeriodInterval(analyticsFilterSchema.parse({ period: 'year' }), fixedNow);
      expect(pYear.granularity).toBe('month');
    });

    it('resolves custom period correctly', () => {
      const parsed = analyticsFilterSchema.parse({ period: 'custom', startDate: '2026-09-01', endDate: '2026-09-10' });
      const interval = resolvePeriodInterval(parsed, fixedNow);
      expect(interval.granularity).toBe('day');
      expect(interval.durationDays).toBe(10);
    });

    it('rejects inverted or missing custom dates in schema validation', () => {
      expect(analyticsFilterSchema.safeParse({ period: 'custom', startDate: '2026-09-10', endDate: '2026-09-01' }).success).toBe(false);
      expect(analyticsFilterSchema.safeParse({ period: 'custom', startDate: '2026-09-10' }).success).toBe(false);
    });
  });

  describe('calculateComparison', () => {
    it('calculates positive and negative percentage changes', () => {
      expect(calculateComparison(120, 100)).toEqual({ current: 120, previous: 100, change: 20, percentageChange: 20 });
      expect(calculateComparison(80, 100)).toEqual({ current: 80, previous: 100, change: -20, percentageChange: -20 });
    });

    it('handles division by zero by returning null percentageChange', () => {
      expect(calculateComparison(15, 0)).toEqual({ current: 15, previous: 0, change: 15, percentageChange: null });
      expect(calculateComparison(0, 0)).toEqual({ current: 0, previous: 0, change: 0, percentageChange: null });
    });
  });

  describe('generateBuckets', () => {
    it('generates daily buckets with zero counts without fabricated records', () => {
      const start = new Date('2026-09-15T03:00:00.000Z');
      const end = new Date('2026-09-18T03:00:00.000Z');
      const buckets = generateBuckets(start, end, 'day');
      expect(buckets.length).toBe(3);
      expect(buckets[0].opened).toBe(0);
      expect(buckets[0].completed).toBe(0);
      expect(buckets[0].label).toMatch(/\d{2}\/\d{2}/);
    });

    it('generates weekly and monthly buckets', () => {
      const start = new Date('2026-06-01T03:00:00.000Z');
      const end = new Date('2026-09-01T03:00:00.000Z');
      const months = generateBuckets(start, end, 'month');
      expect(months.length).toBeGreaterThanOrEqual(3);
      expect(months.every(m => m.opened === 0 && m.completed === 0)).toBe(true);
    });
  });

  describe('CSV sanitization and Injection Protection', () => {
    it('prepends single quote to dangerous spreadsheet formula triggers', () => {
      expect(sanitizeCsvField('=SUM(A1:A10)')).toBe('"\'=SUM(A1:A10)"');
      expect(sanitizeCsvField('   =SUM(A1:A10)')).toBe('"\'   =SUM(A1:A10)"');
      expect(sanitizeCsvField('+12345')).toBe('"\'\+12345"');
      expect(sanitizeCsvField('-cmd')).toBe('"\'\-cmd"');
      expect(sanitizeCsvField('@import')).toBe('"\'\@import"');
      expect(sanitizeCsvField('\tcmd')).toBe('"\'\tcmd"');
      expect(sanitizeCsvField('\n=cmd')).toBe('"\'\n=cmd"');
    });

    it('escapes embedded quotes and handles nulls safely', () => {
      expect(sanitizeCsvField('Item "Especial"')).toBe('"Item ""Especial"""');
      expect(sanitizeCsvField(null)).toBe('""');
      expect(sanitizeCsvField(undefined)).toBe('""');
      expect(sanitizeCsvField('Texto Normal')).toBe('"Texto Normal"');
    });

    it('formats dates in America/Sao_Paulo timezone', () => {
      const d = new Date('2026-09-22T15:30:00.000Z');
      const formatted = formatDateBr(d);
      expect(formatted).toContain('2026');
      expect(formatted).toContain('12:30'); // UTC 15:30 is 12:30 in Sao Paulo (UTC-3)
      expect(formatDateBr(null)).toBe('-');
    });
  });

  describe('canonical analytics contract verification', () => {
    it('returns exclusively the canonical structure with distributions object and no flat keys', async () => {
      const result = await getAnalyticsDashboard({ period: '30d' }, fixedNow);

      expect(result).toHaveProperty('isEmptyDatabase');
      expect(result).toHaveProperty('period');
      expect(result).toHaveProperty('metrics');
      expect(result).toHaveProperty('timeSeries');
      expect(result).toHaveProperty('distributions');
      expect(result).toHaveProperty('teamPerformance');

      // Canonical distributions object must contain all 6 breakdowns
      expect(result.distributions).toHaveProperty('byStatus');
      expect(result.distributions).toHaveProperty('byPriority');
      expect(result.distributions).toHaveProperty('byChannel');
      expect(result.distributions).toHaveProperty('topReasons');
      expect(result.distributions).toHaveProperty('topSubreasons');
      expect(result.distributions).toHaveProperty('backlogAge');

      // Flat duplicate keys must NOT exist on root
      expect(result).not.toHaveProperty('statusDistribution');
      expect(result).not.toHaveProperty('priorityDistribution');
      expect(result).not.toHaveProperty('channelsDistribution');
      expect(result).not.toHaveProperty('topReasons');
      expect(result).not.toHaveProperty('topSubreasons');
      expect(result).not.toHaveProperty('backlogAging');
    });
  });

  describe('CSV stream privacy and masking', () => {
    it('masks customer document CPF/CNPJ in exported CSV rows', async () => {
      const mockRaw = vi.mocked(prisma.$queryRaw);
      mockRaw.mockResolvedValueOnce([
        {
          id: 'sac-1',
          ticket: 'SAC-2026-0001',
          openedAt: new Date('2026-09-01T10:00:00Z'),
          customerName: 'Cliente Teste',
          customerDoc: '12345678901',
          orderNumber: 'PED-123',
          externalTicket: null,
          reasonName: 'Dúvida',
          subreasonName: null,
          channelName: 'WhatsApp',
          priority: 'MEDIUM',
          status: 'PENDING',
          assigneeName: 'Analista',
          dueAt: new Date('2026-09-10T18:00:00Z'),
          completedAt: null,
          identifiedCause: null,
          responsibleArea: null,
          correctiveAction: null,
          lastOperationalActivityAt: new Date('2026-09-01T10:00:00Z'),
        },
      ] as any);
      mockRaw.mockResolvedValueOnce([]); // second batch empty -> terminates loop

      const chunks: string[] = [];
      for await (const chunk of streamAnalyticsCsv({ period: '30d' }, fixedNow)) {
        chunks.push(chunk);
      }
      const fullCsv = chunks.join('');

      expect(fullCsv).toContain('***');
      expect(fullCsv).not.toContain('12345678901');
      expect(fullCsv).not.toContain('789');
    });

    it('exclui registros arquivados/excluídos na consulta de exportação CSV', async () => {
      const mockRaw = vi.mocked(prisma.$queryRaw);
      mockRaw.mockResolvedValueOnce([]);

      for await (const _ of streamAnalyticsCsv({ period: '30d' }, fixedNow)) {
        // consome o stream
      }

      expect(mockRaw).toHaveBeenCalled();
      const sqlObj = mockRaw.mock.calls[0][0] as any;
      const sqlString = Array.isArray(sqlObj?.strings) ? sqlObj.strings.join('') : String(sqlObj);
      expect(sqlString).toContain('"archivedAt" IS NULL');
    });
  });
});
