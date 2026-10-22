import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { civilDateParts, civilDayNumber, operationalBoundaries, resolveClosedDate, zonedDayStart } from '../../domain/operational-attention.js';
import { maskCpfCnpj } from '../../lib/privacy/privacy.service.js';
import type { AnalyticsFilters, AnalyticsPeriod } from './analytics.schema.js';

export const ANALYTICS_TIME_ZONE = 'America/Sao_Paulo';
const DAY_MS = 86_400_000;

export type TimeGranularity = 'day' | 'week' | 'month';

export type ComparisonMetric = {
  current: number;
  previous: number;
  change: number;
  percentageChange: number | null; // null when previous is 0 ("Sem comparação")
};

export type TimeSeriesBucket = {
  key: string;
  label: string;
  opened: number;
  completed: number;
};

export type StatusDistribution = {
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  label: string;
  count: number;
  percentage: number;
};

export type PriorityDistribution = {
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  label: string;
  count: number;
  percentage: number;
};

export type CategoryBreakdown = {
  id: string;
  name: string;
  count: number;
  percentage: number;
  parentName?: string;
};

export type BacklogAgeBucket = {
  range: string;
  label: string;
  count: number;
  percentage: number;
};

export type AssigneePerformance = {
  id: string | null;
  name: string;
  email: string;
  role: string;
  currentlyAssigned: number;
  completedInPeriod: number;
  overdueCount: number;
  avgResolutionSeconds: number | null;
  onTimeRate: number | null;
};

export type AnalyticsDashboardData = {
  isEmptyDatabase: boolean;
  period: {
    selected: AnalyticsPeriod;
    granularity: TimeGranularity;
    currentRange: { start: string; end: string };
    previousRange: { start: string; end: string };
  };
  metrics: {
    // Movements in period
    openedInPeriod: ComparisonMetric;
    completedInPeriod: ComparisonMetric;
    cancelledInPeriod: ComparisonMetric;
    avgResolutionSeconds: {
      current: number | null;
      previous: number | null;
      changeSeconds: number | null;
    };
    slaCompliance: {
      currentRate: number | null;
      previousRate: number | null;
      rateChange: number | null;
      onTimeCount: number;
      lateCount: number;
    };
    // Current snapshot
    currentPending: number;
    currentInProgress: number;
    currentOverdue: number;
    currentNearDue: number;
    currentStale: number;
    currentUnassigned: number;
    currentHighOrCritical: number;
  };
  timeSeries: TimeSeriesBucket[];
  distributions: {
    byStatus: StatusDistribution[];
    byPriority: PriorityDistribution[];
    byChannel: CategoryBreakdown[];
    topReasons: CategoryBreakdown[];
    topSubreasons: CategoryBreakdown[];
    backlogAge: BacklogAgeBucket[];
  };
  teamPerformance: AssigneePerformance[];
};

export function resolvePeriodInterval(filters: AnalyticsFilters, now = new Date()) {
  const todayDayNumber = civilDayNumber(now);
  const tomorrowStart = zonedDayStart(todayDayNumber + 1);

  let start: Date;
  let end: Date = tomorrowStart;

  switch (filters.period) {
    case '7d':
      start = zonedDayStart(todayDayNumber - 6);
      break;
    case '30d':
      start = zonedDayStart(todayDayNumber - 29);
      break;
    case '90d':
      start = zonedDayStart(todayDayNumber - 89);
      break;
    case '6m':
      start = zonedDayStart(todayDayNumber - 179);
      break;
    case 'year': {
      const { year } = civilDateParts(now);
      const jan1 = civilDayNumber(new Date(Date.UTC(year, 0, 1)));
      start = zonedDayStart(jan1);
      break;
    }
    case 'custom': {
      const parsedStart = new Date(filters.startDate!.includes('T') ? filters.startDate! : `${filters.startDate}T00:00:00.000Z`);
      const parsedEnd = new Date(filters.endDate!.includes('T') ? filters.endDate! : `${filters.endDate}T00:00:00.000Z`);
      const startDay = civilDayNumber(parsedStart);
      const endDay = civilDayNumber(parsedEnd);
      start = zonedDayStart(startDay);
      end = zonedDayStart(endDay + 1);
      break;
    }
  }

  const durationMs = Math.max(DAY_MS, end.getTime() - start.getTime());
  const previousEnd = new Date(start.getTime());
  const previousStart = new Date(start.getTime() - durationMs);

  const durationDays = Math.round(durationMs / DAY_MS);
  let granularity: TimeGranularity = 'day';
  if (durationDays > 14 && durationDays <= 90) {
    granularity = 'week';
  } else if (durationDays > 90) {
    granularity = 'month';
  }

  return { currentStart: start, currentEnd: end, previousStart, previousEnd, granularity, durationDays };
}

export function calculateComparison(current: number, previous: number): ComparisonMetric {
  const change = current - previous;
  const percentageChange = previous > 0 ? Number(((change / previous) * 100).toFixed(1)) : null;
  return { current, previous, change, percentageChange };
}

function buildBaseWhere(filters: AnalyticsFilters, userRole?: string, userDepartment?: string | null) {
  const clauses: Prisma.Sql[] = [Prisma.sql`s."archivedAt" IS NULL`];
  if (filters.assigneeId) clauses.push(Prisma.sql`s."assigneeId" = ${filters.assigneeId}`);
  if (filters.reasonId) clauses.push(Prisma.sql`s."reasonId" = ${filters.reasonId}`);
  if (filters.subreasonId) clauses.push(Prisma.sql`s."subreasonId" = ${filters.subreasonId}`);
  if (filters.channelId) clauses.push(Prisma.sql`s."channelId" = ${filters.channelId}`);
  if (filters.priority) clauses.push(Prisma.sql`s."priority"::text = ${filters.priority}`);
  if (filters.status) clauses.push(Prisma.sql`s."status"::text = ${filters.status}`);

  if (userRole !== 'ADMIN') {
    if (userDepartment) {
      clauses.push(Prisma.sql`s."department" = ${userDepartment}`);
    } else {
      clauses.push(Prisma.sql`1 = 0`);
    }
  } else if (filters.department) {
    if (filters.department === 'unassigned' || filters.department === 'none') {
      clauses.push(Prisma.sql`s."department" IS NULL`);
    } else {
      clauses.push(Prisma.sql`s."department" = ${filters.department}`);
    }
  }

  return clauses;
}

export function generateBuckets(start: Date, end: Date, granularity: TimeGranularity): TimeSeriesBucket[] {
  const buckets: TimeSeriesBucket[] = [];
  const current = new Date(start);

  while (current < end) {
    const parts = civilDateParts(current);
    const dayStr = String(parts.day).padStart(2, '0');
    const monthStr = String(parts.month).padStart(2, '0');
    const yearStr = String(parts.year);

    if (granularity === 'day') {
      const key = `${yearStr}-${monthStr}-${dayStr}`;
      buckets.push({ key, label: `${dayStr}/${monthStr}`, opened: 0, completed: 0 });
      current.setTime(current.getTime() + DAY_MS);
    } else if (granularity === 'week') {
      const weekEnd = new Date(Math.min(current.getTime() + 6 * DAY_MS, end.getTime() - 1));
      const endParts = civilDateParts(weekEnd);
      const endDayStr = String(endParts.day).padStart(2, '0');
      const endMonthStr = String(endParts.month).padStart(2, '0');
      const key = `${yearStr}-${monthStr}-${dayStr}`;
      buckets.push({ key, label: `${dayStr}/${monthStr}–${endDayStr}/${endMonthStr}`, opened: 0, completed: 0 });
      current.setTime(current.getTime() + 7 * DAY_MS);
    } else {
      // Month
      const key = `${yearStr}-${monthStr}`;
      const months = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
      buckets.push({ key, label: `${months[parts.month - 1]}/${yearStr.slice(2)}`, opened: 0, completed: 0 });
      // Advance to next month 1st in America/Sao_Paulo
      const nextMonth = parts.month === 12 ? 1 : parts.month + 1;
      const nextYear = parts.month === 12 ? parts.year + 1 : parts.year;
      const nextDayNum = Math.floor(Date.UTC(nextYear, nextMonth - 1, 1) / DAY_MS);
      const nextTime = zonedDayStart(nextDayNum).getTime();
      if (nextTime <= current.getTime()) {
        current.setTime(current.getTime() + 28 * DAY_MS);
      } else {
        current.setTime(nextTime);
      }
    }
  }

  return buckets;
}

export async function getAnalyticsDashboard(
  filters: AnalyticsFilters,
  userRoleOrNow?: string | Date,
  userDepartment?: string | null,
  nowArg = new Date(),
): Promise<AnalyticsDashboardData> {
  let userRole: string | undefined;
  let now: Date;
  if (userRoleOrNow instanceof Date) {
    userRole = 'ADMIN';
    now = userRoleOrNow;
  } else {
    userRole = userRoleOrNow;
    now = nowArg;
  }
  const totalDatabaseRecords = await prisma.sacRecord.count({
    where: {
      archivedAt: null,
      ...(userRole !== 'ADMIN'
        ? (userDepartment ? { department: userDepartment } : { id: '__NONE__' })
        : (filters.department
            ? (filters.department === 'unassigned' || filters.department === 'none' ? { department: null } : { department: filters.department })
            : {})),
    },
  });
  if (totalDatabaseRecords === 0) {
    const interval = resolvePeriodInterval(filters, now);
    return {
      isEmptyDatabase: true,
      period: {
        selected: filters.period,
        granularity: interval.granularity,
        currentRange: { start: interval.currentStart.toISOString(), end: interval.currentEnd.toISOString() },
        previousRange: { start: interval.previousStart.toISOString(), end: interval.previousEnd.toISOString() },
      },
      metrics: {
        openedInPeriod: calculateComparison(0, 0),
        completedInPeriod: calculateComparison(0, 0),
        cancelledInPeriod: calculateComparison(0, 0),
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
  }

  const { currentStart, currentEnd, previousStart, previousEnd, granularity } = resolvePeriodInterval(filters, now);
  const baseClauses = buildBaseWhere(filters, userRole, userDepartment);
  const boundaries = operationalBoundaries(now);

  // 1. Movements in Current vs Previous Period
  const movementQuery = async (start: Date, end: Date) => {
    const whereAnd = Prisma.join([...baseClauses], ' AND ');
    const [result] = await prisma.$queryRaw<Array<{
      opened_count: bigint;
      completed_count: bigint;
      cancelled_count: bigint;
      avg_resolution_seconds: number | null;
      on_time_count: bigint;
      late_count: bigint;
    }>>(Prisma.sql`
      SELECT
        COUNT(*) FILTER (WHERE s."openedAt" >= ${start} AND s."openedAt" < ${end}) AS opened_count,
        COUNT(*) FILTER (WHERE s."status"::text = 'COMPLETED' AND s."completedAt" >= ${start} AND s."completedAt" < ${end}) AS completed_count,
        COUNT(*) FILTER (WHERE s."status"::text = 'CANCELLED' AND (
          (s."cancellationReason" IS NOT NULL AND s."lastOperationalActivityAt" >= ${start} AND s."lastOperationalActivityAt" < ${end})
          OR EXISTS (SELECT 1 FROM "ActivityLog" a WHERE a."recordId" = s."id" AND a."eventType" = 'CANCELLED' AND a."createdAt" >= ${start} AND a."createdAt" < ${end})
        )) AS cancelled_count,
        AVG(EXTRACT(EPOCH FROM (s."completedAt" - s."openedAt"))) FILTER (WHERE s."status"::text = 'COMPLETED' AND s."completedAt" >= ${start} AND s."completedAt" < ${end}) AS avg_resolution_seconds,
        COUNT(*) FILTER (WHERE s."status"::text = 'COMPLETED' AND s."completedAt" >= ${start} AND s."completedAt" < ${end} AND s."completedAt" <= s."dueAt") AS on_time_count,
        COUNT(*) FILTER (WHERE s."status"::text = 'COMPLETED' AND s."completedAt" >= ${start} AND s."completedAt" < ${end} AND s."completedAt" > s."dueAt") AS late_count
      FROM "SacRecord" s
      WHERE ${whereAnd}
    `);
    return {
      opened: Number(result?.opened_count ?? 0n),
      completed: Number(result?.completed_count ?? 0n),
      cancelled: Number(result?.cancelled_count ?? 0n),
      avgResolution: result?.avg_resolution_seconds ? Math.round(Number(result.avg_resolution_seconds)) : null,
      onTime: Number(result?.on_time_count ?? 0n),
      late: Number(result?.late_count ?? 0n),
    };
  };

  const [currentMovement, prevMovement] = await Promise.all([
    movementQuery(currentStart, currentEnd),
    movementQuery(previousStart, previousEnd),
  ]);

  const openedMetric = calculateComparison(currentMovement.opened, prevMovement.opened);
  const completedMetric = calculateComparison(currentMovement.completed, prevMovement.completed);
  const cancelledMetric = calculateComparison(currentMovement.cancelled, prevMovement.cancelled);

  const currentSlaTotal = currentMovement.onTime + currentMovement.late;
  const currentSlaRate = currentSlaTotal > 0 ? Number(((currentMovement.onTime / currentSlaTotal) * 100).toFixed(1)) : null;
  const prevSlaTotal = prevMovement.onTime + prevMovement.late;
  const prevSlaRate = prevSlaTotal > 0 ? Number(((prevMovement.onTime / prevSlaTotal) * 100).toFixed(1)) : null;
  const slaRateChange = currentSlaRate !== null && prevSlaRate !== null ? Number((currentSlaRate - prevSlaRate).toFixed(1)) : null;

  const avgResolutionChange = currentMovement.avgResolution !== null && prevMovement.avgResolution !== null
    ? currentMovement.avgResolution - prevMovement.avgResolution
    : null;

  // 2. Current Operational Snapshot (as of now)
  const snapshotWhereAnd = Prisma.join([...baseClauses], ' AND ');
  const [snapshot] = await prisma.$queryRaw<Array<{
    pending_count: bigint;
    in_progress_count: bigint;
    overdue_count: bigint;
    near_due_count: bigint;
    stale_count: bigint;
    unassigned_count: bigint;
    high_critical_count: bigint;
  }>>(Prisma.sql`
    SELECT
      COUNT(*) FILTER (WHERE s."status"::text = 'PENDING') AS pending_count,
      COUNT(*) FILTER (WHERE s."status"::text = 'IN_PROGRESS') AS in_progress_count,
      COUNT(*) FILTER (WHERE s."status"::text IN ('PENDING', 'IN_PROGRESS') AND s."dueAt" < ${boundaries.todayStart}) AS overdue_count,
      COUNT(*) FILTER (WHERE s."status"::text IN ('PENDING', 'IN_PROGRESS') AND s."dueAt" >= ${boundaries.tomorrowStart} AND s."dueAt" < ${boundaries.nearDueEnd}) AS near_due_count,
      COUNT(*) FILTER (WHERE s."status"::text IN ('PENDING', 'IN_PROGRESS') AND s."lastOperationalActivityAt" <= ${boundaries.staleBefore}) AS stale_count,
      COUNT(*) FILTER (WHERE s."status"::text IN ('PENDING', 'IN_PROGRESS') AND s."assigneeId" IS NULL) AS unassigned_count,
      COUNT(*) FILTER (WHERE s."status"::text IN ('PENDING', 'IN_PROGRESS') AND s."priority"::text IN ('HIGH', 'CRITICAL')) AS high_critical_count
    FROM "SacRecord" s
    WHERE ${snapshotWhereAnd}
  `);

  // 3. Time Series Data (Bucketed with Zero-filling)
  const buckets = generateBuckets(currentStart, currentEnd, granularity);
  const bucketMap = new Map<string, TimeSeriesBucket>();
  for (const b of buckets) {
    bucketMap.set(b.key, b);
  }

  // Fetch actual opened and completed in period
  const timeSeriesRows = await prisma.$queryRaw<Array<{
    opened_at: Date;
    completed_at: Date | null;
  }>>(Prisma.sql`
    SELECT s."openedAt" AS opened_at, s."completedAt" AS completed_at
    FROM "SacRecord" s
    WHERE ${snapshotWhereAnd}
      AND ((s."openedAt" >= ${currentStart} AND s."openedAt" < ${currentEnd})
        OR (s."status"::text = 'COMPLETED' AND s."completedAt" >= ${currentStart} AND s."completedAt" < ${currentEnd}))
  `);

  const getBucketKey = (date: Date): string => {
    const parts = civilDateParts(date);
    const dayStr = String(parts.day).padStart(2, '0');
    const monthStr = String(parts.month).padStart(2, '0');
    const yearStr = String(parts.year);

    if (granularity === 'day') {
      return `${yearStr}-${monthStr}-${dayStr}`;
    }
    if (granularity === 'month') {
      return `${yearStr}-${monthStr}`;
    }
    // Week: find matching week bucket
    const targetMs = date.getTime();
    for (let i = 0; i < buckets.length; i++) {
      const bKey = buckets[i].key;
      const bDate = new Date(bKey.includes('T') ? bKey : `${bKey}T00:00:00.000Z`);
      const nextDateMs = (i + 1 < buckets.length)
        ? new Date(`${buckets[i + 1].key}T00:00:00.000Z`).getTime()
        : currentEnd.getTime();
      if (targetMs >= bDate.getTime() && targetMs < nextDateMs) {
        return bKey;
      }
    }
    return buckets[0]?.key ?? `${yearStr}-${monthStr}-${dayStr}`;
  };

  for (const row of timeSeriesRows) {
    if (row.opened_at >= currentStart && row.opened_at < currentEnd) {
      const key = getBucketKey(row.opened_at);
      const b = bucketMap.get(key);
      if (b) b.opened += 1;
    }
    if (row.completed_at && row.completed_at >= currentStart && row.completed_at < currentEnd) {
      const key = getBucketKey(row.completed_at);
      const b = bucketMap.get(key);
      if (b) b.completed += 1;
    }
  }

  // 4. Distributions
  // 4a. Status Distribution (for cases matching filters and created within period)
  const statusCounts = await prisma.$queryRaw<Array<{ status: string; count: bigint }>>(Prisma.sql`
    SELECT s."status"::text AS status, COUNT(*) AS count
    FROM "SacRecord" s
    WHERE ${snapshotWhereAnd} AND s."openedAt" >= ${currentStart} AND s."openedAt" < ${currentEnd}
    GROUP BY s."status"
  `);
  const totalInPeriod = Number(statusCounts.reduce((acc, row) => acc + row.count, 0n));
  const statusLabels: Record<string, string> = { PENDING: 'Pendente', IN_PROGRESS: 'Em andamento', COMPLETED: 'Concluído', CANCELLED: 'Cancelado' };
  const byStatus: StatusDistribution[] = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'].map(st => {
    const found = statusCounts.find(row => row.status === st);
    const count = found ? Number(found.count) : 0;
    return {
      status: st as StatusDistribution['status'],
      label: statusLabels[st] ?? st,
      count,
      percentage: totalInPeriod > 0 ? Number(((count / totalInPeriod) * 100).toFixed(1)) : 0,
    };
  });

  // 4b. Priority Distribution
  const priorityCounts = await prisma.$queryRaw<Array<{ priority: string; count: bigint }>>(Prisma.sql`
    SELECT s."priority"::text AS priority, COUNT(*) AS count
    FROM "SacRecord" s
    WHERE ${snapshotWhereAnd} AND s."openedAt" >= ${currentStart} AND s."openedAt" < ${currentEnd}
    GROUP BY s."priority"
  `);
  const priorityLabels: Record<string, string> = { LOW: 'Baixa', MEDIUM: 'Média', HIGH: 'Alta', CRITICAL: 'Crítica' };
  const byPriority: PriorityDistribution[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map(pr => {
    const found = priorityCounts.find(row => row.priority === pr);
    const count = found ? Number(found.count) : 0;
    return {
      priority: pr as PriorityDistribution['priority'],
      label: priorityLabels[pr] ?? pr,
      count,
      percentage: totalInPeriod > 0 ? Number(((count / totalInPeriod) * 100).toFixed(1)) : 0,
    };
  });

  // 4c. Top Reasons
  const reasonRows = await prisma.$queryRaw<Array<{ id: string; name: string; count: bigint }>>(Prisma.sql`
    SELECT r."id", r."name", COUNT(s."id") AS count
    FROM "SacRecord" s
    JOIN "Reason" r ON r."id" = s."reasonId"
    WHERE ${snapshotWhereAnd} AND s."openedAt" >= ${currentStart} AND s."openedAt" < ${currentEnd}
    GROUP BY r."id", r."name"
    ORDER BY count DESC
    LIMIT 6
  `);
  const topReasons: CategoryBreakdown[] = reasonRows.map(row => {
    const count = Number(row.count);
    return {
      id: row.id,
      name: row.name,
      count,
      percentage: totalInPeriod > 0 ? Number(((count / totalInPeriod) * 100).toFixed(1)) : 0,
    };
  });

  // 4d. Top Subreasons
  const subreasonRows = await prisma.$queryRaw<Array<{ id: string; name: string; parent_name: string; count: bigint }>>(Prisma.sql`
    SELECT sub."id", sub."name", r."name" AS parent_name, COUNT(s."id") AS count
    FROM "SacRecord" s
    JOIN "Subreason" sub ON sub."id" = s."subreasonId"
    JOIN "Reason" r ON r."id" = s."reasonId"
    WHERE ${snapshotWhereAnd} AND s."openedAt" >= ${currentStart} AND s."openedAt" < ${currentEnd}
    GROUP BY sub."id", sub."name", r."name"
    ORDER BY count DESC
    LIMIT 6
  `);
  const topSubreasons: CategoryBreakdown[] = subreasonRows.map(row => {
    const count = Number(row.count);
    return {
      id: row.id,
      name: row.name,
      parentName: row.parent_name,
      count,
      percentage: totalInPeriod > 0 ? Number(((count / totalInPeriod) * 100).toFixed(1)) : 0,
    };
  });

  // 4e. Channels
  const channelRows = await prisma.$queryRaw<Array<{ id: string; name: string; count: bigint }>>(Prisma.sql`
    SELECT COALESCE(c."id", 'unknown') AS id, COALESCE(c."name", s."channel") AS name, COUNT(s."id") AS count
    FROM "SacRecord" s
    LEFT JOIN "Channel" c ON c."id" = s."channelId"
    WHERE ${snapshotWhereAnd} AND s."openedAt" >= ${currentStart} AND s."openedAt" < ${currentEnd}
    GROUP BY COALESCE(c."id", 'unknown'), COALESCE(c."name", s."channel")
    ORDER BY count DESC
  `);
  const byChannel: CategoryBreakdown[] = channelRows.map(row => {
    const count = Number(row.count);
    return {
      id: row.id,
      name: row.name,
      count,
      percentage: totalInPeriod > 0 ? Number(((count / totalInPeriod) * 100).toFixed(1)) : 0,
    };
  });

  // 4f. Backlog Age Buckets (for currently open cases)
  const [backlogAgeCounts] = await prisma.$queryRaw<Array<{
    b0_3: bigint;
    b4_7: bigint;
    b8_15: bigint;
    b16_30: bigint;
    b_gt30: bigint;
  }>>(Prisma.sql`
    SELECT
      COUNT(*) FILTER (WHERE s."status"::text IN ('PENDING', 'IN_PROGRESS') AND s."createdAt" >= ${new Date(now.getTime() - 3 * DAY_MS)}) AS b0_3,
      COUNT(*) FILTER (WHERE s."status"::text IN ('PENDING', 'IN_PROGRESS') AND s."createdAt" < ${new Date(now.getTime() - 3 * DAY_MS)} AND s."createdAt" >= ${new Date(now.getTime() - 7 * DAY_MS)}) AS b4_7,
      COUNT(*) FILTER (WHERE s."status"::text IN ('PENDING', 'IN_PROGRESS') AND s."createdAt" < ${new Date(now.getTime() - 7 * DAY_MS)} AND s."createdAt" >= ${new Date(now.getTime() - 15 * DAY_MS)}) AS b8_15,
      COUNT(*) FILTER (WHERE s."status"::text IN ('PENDING', 'IN_PROGRESS') AND s."createdAt" < ${new Date(now.getTime() - 15 * DAY_MS)} AND s."createdAt" >= ${new Date(now.getTime() - 30 * DAY_MS)}) AS b16_30,
      COUNT(*) FILTER (WHERE s."status"::text IN ('PENDING', 'IN_PROGRESS') AND s."createdAt" < ${new Date(now.getTime() - 30 * DAY_MS)}) AS b_gt30
    FROM "SacRecord" s
    WHERE ${snapshotWhereAnd}
  `);
  const b0_3 = Number(backlogAgeCounts?.b0_3 ?? 0n);
  const b4_7 = Number(backlogAgeCounts?.b4_7 ?? 0n);
  const b8_15 = Number(backlogAgeCounts?.b8_15 ?? 0n);
  const b16_30 = Number(backlogAgeCounts?.b16_30 ?? 0n);
  const b_gt30 = Number(backlogAgeCounts?.b_gt30 ?? 0n);
  const totalBacklog = b0_3 + b4_7 + b8_15 + b16_30 + b_gt30;
  const calcBacklogPct = (count: number) => (totalBacklog > 0 ? Number(((count / totalBacklog) * 100).toFixed(1)) : 0);

  const backlogAge: BacklogAgeBucket[] = [
    { range: '0-3d', label: '0 a 3 dias', count: b0_3, percentage: calcBacklogPct(b0_3) },
    { range: '4-7d', label: '4 a 7 dias', count: b4_7, percentage: calcBacklogPct(b4_7) },
    { range: '8-15d', label: '8 a 15 dias', count: b8_15, percentage: calcBacklogPct(b8_15) },
    { range: '16-30d', label: '16 a 30 dias', count: b16_30, percentage: calcBacklogPct(b16_30) },
    { range: '>30d', label: 'Mais de 30 dias', count: b_gt30, percentage: calcBacklogPct(b_gt30) },
  ];

  // 5. Team Performance (by Assignee, verified and non-punitive)
  const assigneeRows = await prisma.$queryRaw<Array<{
    user_id: string | null;
    user_name: string | null;
    currently_assigned: bigint;
    overdue_count: bigint;
    completed_count: bigint;
    avg_resolution_seconds: number | null;
    on_time_count: bigint;
    late_count: bigint;
  }>>(Prisma.sql`
    SELECT
      u."id" AS user_id,
      COALESCE(u."name", 'Sem responsável') AS user_name,
      COUNT(s."id") FILTER (WHERE s."status"::text IN ('PENDING', 'IN_PROGRESS')) AS currently_assigned,
      COUNT(s."id") FILTER (WHERE s."status"::text IN ('PENDING', 'IN_PROGRESS') AND s."dueAt" < ${boundaries.todayStart}) AS overdue_count,
      COUNT(s."id") FILTER (WHERE s."status"::text = 'COMPLETED' AND s."completedAt" >= ${currentStart} AND s."completedAt" < ${currentEnd}) AS completed_count,
      AVG(EXTRACT(EPOCH FROM (s."completedAt" - s."openedAt"))) FILTER (WHERE s."status"::text = 'COMPLETED' AND s."completedAt" >= ${currentStart} AND s."completedAt" < ${currentEnd}) AS avg_resolution_seconds,
      COUNT(s."id") FILTER (WHERE s."status"::text = 'COMPLETED' AND s."completedAt" >= ${currentStart} AND s."completedAt" < ${currentEnd} AND s."completedAt" <= s."dueAt") AS on_time_count,
      COUNT(s."id") FILTER (WHERE s."status"::text = 'COMPLETED' AND s."completedAt" >= ${currentStart} AND s."completedAt" < ${currentEnd} AND s."completedAt" > s."dueAt") AS late_count
    FROM "SacRecord" s
    LEFT JOIN "User" u ON u."id" = s."assigneeId"
    WHERE ${snapshotWhereAnd}
    GROUP BY u."id", u."name"
    HAVING (
      COUNT(s."id") FILTER (WHERE s."status"::text IN ('PENDING', 'IN_PROGRESS')) > 0
      OR COUNT(s."id") FILTER (WHERE s."status"::text = 'COMPLETED' AND s."completedAt" >= ${currentStart} AND s."completedAt" < ${currentEnd}) > 0
    )
    ORDER BY currently_assigned DESC, user_name ASC
  `);

  const teamPerformance: AssigneePerformance[] = assigneeRows.map(row => {
    const onTime = Number(row.on_time_count);
    const late = Number(row.late_count);
    const totalComp = onTime + late;
    const assigned = Number(row.currently_assigned);
    const completed = Number(row.completed_count);
    const overdue = Number(row.overdue_count);
    return {
      id: row.user_id,
      name: row.user_name ?? 'Sem responsável',
      email: '',
      role: 'Membro',
      currentlyAssigned: assigned,
      completedInPeriod: completed,
      overdueCount: overdue,
      avgResolutionSeconds: row.avg_resolution_seconds ? Math.round(Number(row.avg_resolution_seconds)) : null,
      onTimeRate: totalComp > 0 ? Number(((onTime / totalComp) * 100).toFixed(1)) : null,
    };
  });

  return {
    isEmptyDatabase: false,
    period: {
      selected: filters.period,
      granularity,
      currentRange: { start: currentStart.toISOString(), end: currentEnd.toISOString() },
      previousRange: { start: previousStart.toISOString(), end: previousEnd.toISOString() },
    },
    metrics: {
      openedInPeriod: openedMetric,
      completedInPeriod: completedMetric,
      cancelledInPeriod: cancelledMetric,
      avgResolutionSeconds: {
        current: currentMovement.avgResolution,
        previous: prevMovement.avgResolution,
        changeSeconds: avgResolutionChange,
      },
      slaCompliance: {
        currentRate: currentSlaRate,
        previousRate: prevSlaRate,
        rateChange: slaRateChange,
        onTimeCount: currentMovement.onTime,
        lateCount: currentMovement.late,
      },
      currentPending: Number(snapshot?.pending_count ?? 0n),
      currentInProgress: Number(snapshot?.in_progress_count ?? 0n),
      currentOverdue: Number(snapshot?.overdue_count ?? 0n),
      currentNearDue: Number(snapshot?.near_due_count ?? 0n),
      currentStale: Number(snapshot?.stale_count ?? 0n),
      currentUnassigned: Number(snapshot?.unassigned_count ?? 0n),
      currentHighOrCritical: Number(snapshot?.high_critical_count ?? 0n),
    },
    timeSeries: buckets,
    distributions: {
      byStatus,
      byPriority,
      byChannel,
      topReasons,
      topSubreasons,
      backlogAge,
    },
    teamPerformance,
  };
}

export function sanitizeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '""';
  let str = String(value);
  // CSV Injection prevention: prefix dangerous starting characters with single quote (including after leading whitespace)
  if (/^\s*[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  // Escape quotes
  const escaped = str.replace(/"/g, '""');
  return `"${escaped}"`;
}

export function formatDateBr(date: Date | null): string {
  if (!date) return '-';
  return date.toLocaleString('pt-BR', { timeZone: ANALYTICS_TIME_ZONE });
}

export async function* streamAnalyticsCsv(
  filters: AnalyticsFilters,
  userRoleOrNow?: string | Date,
  userDepartment?: string | null,
  nowArg = new Date(),
) {
  let userRole: string | undefined;
  let now: Date;
  if (userRoleOrNow instanceof Date) {
    userRole = 'ADMIN';
    now = userRoleOrNow;
  } else {
    userRole = userRoleOrNow;
    now = nowArg;
  }
  // UTF-8 BOM for Excel compatibility
  yield '\uFEFF';

  const headers = [
    'Ticket',
    'Data de Abertura',
    'Cliente',
    'Documento',
    'Pedido',
    'Protocolo Externo',
    'Motivo',
    'Submotivo',
    'Canal',
    'Prioridade',
    'Status',
    'Responsável',
    'Setor',
    'Prazo',
    'Data de Conclusão',
    'Cumprimento do Prazo',
    'Causa Identificada',
    'Área Responsável',
    'Ação Corretiva',
    'Última Atualização Operacional',
  ];

  yield headers.map(sanitizeCsvField).join(';') + '\r\n';

  const { currentStart, currentEnd } = resolvePeriodInterval(filters, now);
  const whereClauses = buildBaseWhere(filters, userRole, userDepartment);
  whereClauses.push(Prisma.sql`s."openedAt" >= ${currentStart} AND s."openedAt" < ${currentEnd}`);
  const whereAnd = Prisma.join(whereClauses, ' AND ');

  const batchSize = 250;
  let cursorId: string | null = null;
  let hasMore = true;

  const statusMap: Record<string, string> = { PENDING: 'Pendente', IN_PROGRESS: 'Em andamento', COMPLETED: 'Concluído', CANCELLED: 'Cancelado' };
  const priorityMap: Record<string, string> = { LOW: 'Baixa', MEDIUM: 'Média', HIGH: 'Alta', CRITICAL: 'Crítica' };

  type ExportRecordRow = {
    id: string;
    ticket: string;
    openedAt: Date;
    customerName: string;
    customerDoc: string | null;
    orderNumber: string;
    externalTicket: string | null;
    reasonName: string;
    subreasonName: string | null;
    channelName: string;
    priority: string;
    status: string;
    assigneeName: string | null;
    department: string | null;
    dueAt: Date;
    completedAt: Date | null;
    identifiedCause: string | null;
    responsibleArea: string | null;
    correctiveAction: string | null;
    lastOperationalActivityAt: Date;
  };

  while (hasMore) {
    const cursorClause: Prisma.Sql = cursorId ? Prisma.sql`AND s."id" > ${cursorId}` : Prisma.empty;
    const batch: ExportRecordRow[] = await prisma.$queryRaw<ExportRecordRow[]>(Prisma.sql`
      SELECT
        s."id",
        s."ticket",
        s."openedAt",
        c."name" AS "customerName",
        c."document" AS "customerDoc",
        s."orderNumber",
        s."externalTicket",
        r."name" AS "reasonName",
        sub."name" AS "subreasonName",
        COALESCE(ch."name", s."channel") AS "channelName",
        s."priority"::text AS "priority",
        s."status"::text AS "status",
        u."name" AS "assigneeName",
        s."department",
        s."dueAt",
        s."completedAt",
        s."identifiedCause",
        s."responsibleArea",
        s."correctiveAction",
        s."lastOperationalActivityAt"
      FROM "SacRecord" s
      JOIN "Customer" c ON c."id" = s."customerId"
      JOIN "Reason" r ON r."id" = s."reasonId"
      LEFT JOIN "Subreason" sub ON sub."id" = s."subreasonId"
      LEFT JOIN "Channel" ch ON ch."id" = s."channelId"
      LEFT JOIN "User" u ON u."id" = s."assigneeId"
      WHERE ${whereAnd} ${cursorClause}
      ORDER BY s."id" ASC
      LIMIT ${batchSize}
    `);

    if (batch.length === 0) {
      hasMore = false;
      break;
    }

    const legacyClosedInBatch = batch
      .filter(r => (r.status === 'COMPLETED' || r.status === 'CANCELLED') && !r.completedAt)
      .map(r => r.id);

    let legacyActivitiesMap: Record<string, Array<{ eventType: string; createdAt: Date }>> = {};
    if (legacyClosedInBatch.length > 0) {
      const logs = await prisma.activityLog.findMany({
        where: {
          recordId: { in: legacyClosedInBatch },
          eventType: { in: ['COMPLETED', 'CANCELLED', 'REOPENED', 'REACTIVATED'] },
        },
        select: { recordId: true, eventType: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      });
      for (const log of logs) {
        if (!legacyActivitiesMap[log.recordId]) legacyActivitiesMap[log.recordId] = [];
        legacyActivitiesMap[log.recordId].push(log);
      }
    }

    for (let i = 0; i < batch.length; i++) {
      const record: ExportRecordRow = batch[i];
      const activities = legacyActivitiesMap[record.id];
      const effectiveClosedDate = resolveClosedDate({
        status: record.status,
        completedAt: record.completedAt,
        activities,
      });

      let slaCompliance = 'Em aberto';
      if (record.status === 'COMPLETED') {
        if (effectiveClosedDate) {
          slaCompliance = effectiveClosedDate <= record.dueAt ? 'No prazo' : 'Fora do prazo';
        } else {
          slaCompliance = 'Duração indisponível';
        }
      } else if (record.status === 'CANCELLED') {
        slaCompliance = 'Cancelado';
      } else if (record.dueAt < now) {
        slaCompliance = 'Atrasado';
      }

      const row = [
        record.ticket,
        formatDateBr(record.openedAt),
        record.customerName,
        record.customerDoc ? maskCpfCnpj(record.customerDoc) : '-',
        record.orderNumber,
        record.externalTicket ?? '-',
        record.reasonName,
        record.subreasonName ?? '-',
        record.channelName,
        priorityMap[record.priority] ?? record.priority,
        statusMap[record.status] ?? record.status,
        record.assigneeName ?? 'Sem responsável',
        record.department ?? 'Não classificado',
        formatDateBr(record.dueAt),
        formatDateBr(effectiveClosedDate),
        slaCompliance,
        record.identifiedCause ?? '-',
        record.responsibleArea ?? '-',
        record.correctiveAction ?? '-',
        formatDateBr(record.lastOperationalActivityAt),
      ];

      yield row.map(sanitizeCsvField).join(';') + '\r\n';
      cursorId = record.id;
    }

    if (batch.length < batchSize) {
      hasMore = false;
    }
  }
}
