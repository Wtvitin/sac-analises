import { API_URL, apiRequest } from './api.js';

export type AnalyticsPeriod = '7d' | '30d' | '90d' | '6m' | 'year' | 'custom';

export type AnalyticsFilters = {
  period: AnalyticsPeriod;
  startDate?: string;
  endDate?: string;
  reasonId?: string;
  subreasonId?: string;
  channelId?: string;
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  status?: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
};

export const DEFAULT_ANALYTICS_FILTERS: AnalyticsFilters = {
  period: '30d',
};

export type ComparisonMetric = {
  current: number;
  previous: number;
  change: number;
  percentageChange: number | null;
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
};

export type BacklogAgingBucket = {
  range: string;
  label?: string;
  count: number;
  percentage: number;
};

export type TeamPerformanceRow = {
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
    granularity: 'day' | 'week' | 'month';
    currentRange: { start: string; end: string };
    previousRange: { start: string; end: string };
  };
  metrics: {
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
    backlogAge: BacklogAgingBucket[];
  };
  teamPerformance: TeamPerformanceRow[];
};

export function serializeAnalyticsParams(filters: AnalyticsFilters): URLSearchParams {
  const params = new URLSearchParams({ period: filters.period });
  if (filters.period === 'custom') {
    if (filters.startDate) params.set('startDate', filters.startDate);
    if (filters.endDate) params.set('endDate', filters.endDate);
  }
  if (filters.reasonId) params.set('reasonId', filters.reasonId);
  if (filters.subreasonId) params.set('subreasonId', filters.subreasonId);
  if (filters.channelId) params.set('channelId', filters.channelId);
  if (filters.priority) params.set('priority', filters.priority);
  if (filters.status) params.set('status', filters.status);
  return params;
}

export async function fetchDashboardAnalytics(filters: AnalyticsFilters, signal?: AbortSignal): Promise<AnalyticsDashboardData> {
  const params = serializeAnalyticsParams(filters);
  return apiRequest<AnalyticsDashboardData>(`/analytics/dashboard?${params.toString()}`, { signal });
}

export async function downloadAnalyticsCsv(filters: AnalyticsFilters): Promise<void> {
  const params = serializeAnalyticsParams(filters);
  const response = await fetch(`${API_URL}/analytics/export?${params.toString()}`, {
    credentials: 'include',
  });

  if (!response.ok) {
    const errorJson = await response.json().catch(() => ({}));
    throw new Error(errorJson?.error?.message ?? 'Falha ao exportar relatório CSV.');
  }

  const blob = await response.blob();
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  anchor.download = `relatorio-operacional-sac-${yyyy}-${mm}-${dd}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.URL.revokeObjectURL(url);
}

export function formatResolutionTime(seconds: number | null): string {
  if (seconds === null || seconds < 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

export function formatPercentageChange(percentage: number | null): { text: string; polarity: 'positive' | 'negative' | 'neutral' } {
  if (percentage === null) {
    return { text: 'Sem base anterior', polarity: 'neutral' };
  }
  if (percentage === 0) {
    return { text: '0,0%', polarity: 'neutral' };
  }
  const formatted = Math.abs(percentage).toFixed(1).replace('.', ',');
  if (percentage > 0) {
    return { text: `+${formatted}%`, polarity: 'positive' };
  }
  return { text: `-${formatted}%`, polarity: 'negative' };
}

export function formatRate(rate: number | null): string {
  if (rate === null) return '—';
  return `${rate.toFixed(1).replace('.', ',')}%`;
}
