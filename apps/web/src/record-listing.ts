import type { RecordItem, Status } from './data';

export type AttentionFilter = 'Todos' | 'Requer atenção' | 'Atrasados' | 'Vencem hoje' | 'Próximos do prazo' | 'Sem atualização' | 'Sem responsável' | 'Sem prazo';
export type SortKey = 'default' | 'attention' | 'ticket' | 'customer' | 'priority' | 'status' | 'due' | 'openedAt' | 'createdAt' | 'updated';
export type SortOrder = 'asc' | 'desc';

export const OPERATIONAL_TIME_ZONE = 'America/Sao_Paulo';
const DAY_MS = 86_400_000;

const civilFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: OPERATIONAL_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function civilDateParts(date: Date) {
  const values = Object.fromEntries(
    civilFormatter
      .formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, Number(part.value)])
  );
  return { year: values.year, month: values.month, day: values.day };
}

export function civilDayNumber(date: Date) {
  const { year, month, day } = civilDateParts(date);
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

export type RecordFilters = {
  status: 'Todos' | Status;
  priority: 'Todas' | RecordItem['priority'];
  owner: string;
  reason: string;
  department?: string;
  startDate: string;
  endDate: string;
  attention: AttentionFilter;
};

export const EMPTY_RECORD_FILTERS: RecordFilters = {
  status: 'Todos',
  priority: 'Todas',
  owner: 'Todos',
  reason: 'Todos',
  department: 'Todos',
  startDate: '',
  endDate: '',
  attention: 'Todos',
};

/** Serializes list controls; all filtering and sorting precede pagination on the API. */
export function recordListParams(query: string, filters: RecordFilters, sort: SortKey, order: SortOrder, page: number, pageSize: number) {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), sort: sort === 'default' || sort === 'updated' ? 'updatedAt' : sort === 'due' ? 'dueAt' : sort, order: sort === 'default' ? 'desc' : order });
  if (query.trim()) params.set('query', query.trim().slice(0, 120));
  if (filters.status !== 'Todos') params.set('status', ({ Pendente: 'PENDING', 'Em andamento': 'IN_PROGRESS', Concluído: 'COMPLETED', Cancelado: 'CANCELLED' })[filters.status]);
  if (filters.priority !== 'Todas') params.set('priority', ({ Baixa: 'LOW', Média: 'MEDIUM', Alta: 'HIGH', Crítica: 'CRITICAL' })[filters.priority]);
  if (filters.owner !== 'Todos') params.set('owner', filters.owner);
  if (filters.reason !== 'Todos') params.set('reason', filters.reason);
  if (filters.department && filters.department !== 'Todos') params.set('department', filters.department);
  if (filters.startDate) params.set('openedFrom', new Date(`${filters.startDate}T00:00:00`).toISOString());
  if (filters.endDate) { const end = new Date(`${filters.endDate}T00:00:00`); end.setDate(end.getDate() + 1); params.set('openedTo', end.toISOString()); }
  const attentionMap: Record<Exclude<AttentionFilter, 'Todos'>, string> = { 'Requer atenção': 'required', Atrasados: 'overdue', 'Vencem hoje': 'dueToday', 'Próximos do prazo': 'nearDue', 'Sem atualização': 'stale', 'Sem responsável': 'unassigned', 'Sem prazo': 'noDue' };
  if (filters.attention !== 'Todos') params.set('attention', attentionMap[filters.attention]);
  return params;
}

const priorityRank: Record<RecordItem['priority'], number> = { Baixa: 1, Média: 2, Alta: 3, Crítica: 4 };
const statusRank: Record<Status, number> = { Pendente: 1, 'Em andamento': 2, Concluído: 3, Cancelado: 4 };

export function normalizeSearch(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').trim();
}

export function parseBrazilianDate(value: string) {
  const match = value.match(/(\d{2})\/(\d{2})\/(\d{4})(?:,?\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return null;
  const [, day, month, year, hour = '12', minute = '00', second = '00'] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const iso = new Date(value);
  if (!Number.isNaN(iso.getTime()) && (value.includes('-') || value.includes('T'))) {
    return iso;
  }
  return parseBrazilianDate(value);
}

export function isRecordOverdue(record: RecordItem) {
  return record.operational.isOverdue;
}

export function getDueLabel(record: RecordItem) {
  const flags = record.operational;
  if (flags.dueState === 'CLOSED') return '';
  if (flags.dueState === 'NO_DUE') return 'Sem prazo';
  if (flags.isDueToday) return 'Vence hoje';
  if (flags.isNearDue) return 'Próximo do prazo';
  if (flags.isOverdue) return `Atrasado há ${flags.overdueDays} ${flags.overdueDays === 1 ? 'dia' : 'dias'}`;
  return 'Dentro do prazo';
}

export function getRelativeUpdate(value: string, now = new Date()) {
  if (value === 'Agora') return { relative: 'Agora', full: 'Agora' };
  const date = parseDate(value);
  if (!date) return { relative: value, full: value };
  const milliseconds = Math.max(0, now.getTime() - date.getTime());
  const minutes = Math.floor(milliseconds / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const relative = minutes < 1 ? 'Agora' : minutes < 60 ? `Há ${minutes} min` : hours < 24 ? `Há ${hours} ${hours === 1 ? 'hora' : 'horas'}` : days < 7 ? `Há ${days} ${days === 1 ? 'dia' : 'dias'}` : date.toLocaleDateString('pt-BR');
  const full = `${date.toLocaleDateString('pt-BR')} às ${date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  return { relative, full };
}

export type OpenDurationInput =
  | string
  | Date
  | {
      createdAt?: string | Date | null;
      openedAt?: string | Date | null;
      status?: string | null;
      completedAt?: string | Date | null;
      updatedAt?: string | Date | null;
      operational?: { openDays?: number | null };
      activities?: Array<{ eventType: string; createdAt: string | Date; [key: string]: any }>;
    };

export function resolveClosedDate(input: {
  status?: string | null;
  completedAt?: string | Date | null;
  activities?: Array<{ eventType: string; createdAt: string | Date; [key: string]: any }>;
}): Date | null {
  const isClosed =
    input.status === 'COMPLETED' ||
    input.status === 'CANCELLED' ||
    input.status === 'Concluído' ||
    input.status === 'Cancelado';
  if (!isClosed) return null;

  // 1. Prioritize a persisted and reliable closing date
  if (input.completedAt) {
    const parsed = parseDate(input.completedAt);
    if (parsed) return parsed;
  }

  // 2. For legacy cases without completedAt, consult the last valid completion or cancellation event of the current cycle in history
  if (input.activities && input.activities.length > 0) {
    const parsedActivities = input.activities
      .map(a => ({
        eventType: a.eventType,
        createdAt: parseDate(a.createdAt),
      }))
      .filter((a): a is { eventType: string; createdAt: Date } => a.createdAt !== null)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    let lastReopenIndex = -1;
    for (let i = parsedActivities.length - 1; i >= 0; i--) {
      if (parsedActivities[i].eventType === 'REOPENED' || parsedActivities[i].eventType === 'REACTIVATED') {
        lastReopenIndex = i;
        break;
      }
    }

    const targetEvent =
      input.status === 'COMPLETED' || input.status === 'Concluído' ? 'COMPLETED' : 'CANCELLED';

    for (let i = parsedActivities.length - 1; i > lastReopenIndex; i--) {
      if (parsedActivities[i].eventType === targetEvent) {
        return parsedActivities[i].createdAt;
      }
    }
  }

  // 3. If no reliable evidence exists, return null (never invent a date, never use updatedAt)
  return null;
}

export function calculateOpenDays(input: OpenDurationInput, now = new Date()): number | null {
  if (typeof input === 'object' && input !== null && !(input instanceof Date)) {
    if (input.operational && 'openDays' in input.operational) {
      if (typeof input.operational.openDays === 'number') {
        return input.operational.openDays;
      }
      if (input.operational.openDays === null) {
        return null;
      }
    }
    const startDate = parseDate(input.createdAt ?? input.openedAt);
    if (!startDate) return null;

    const isClosed =
      input.status === 'COMPLETED' ||
      input.status === 'CANCELLED' ||
      input.status === 'Concluído' ||
      input.status === 'Cancelado';

    if (!isClosed) {
      return Math.max(0, civilDayNumber(now) - civilDayNumber(startDate));
    }

    const closedDate = resolveClosedDate(input);
    if (!closedDate) return null;
    return Math.max(0, civilDayNumber(closedDate) - civilDayNumber(startDate));
  }

  const startDate = parseDate(input);
  if (!startDate) return null;
  return Math.max(0, civilDayNumber(now) - civilDayNumber(startDate));
}

export function getOpenDuration(input: OpenDurationInput, now = new Date()): string {
  const startDate =
    typeof input === 'object' && input !== null && !(input instanceof Date)
      ? parseDate(input.createdAt ?? input.openedAt)
      : parseDate(input);
  if (!startDate) return '—';

  const days = calculateOpenDays(input, now);
  if (days === null) return 'Duração indisponível';
  if (days === 0) return 'Hoje';
  if (days === 1) return '1 dia';
  return `${days} dias`;
}

export function hasActiveFilters(filters: RecordFilters) {
  return filters.status !== 'Todos' || filters.priority !== 'Todas' || filters.owner !== 'Todos' || filters.reason !== 'Todos' || Boolean(filters.startDate || filters.endDate) || filters.attention !== 'Todos' || (Boolean(filters.department) && filters.department !== 'Todos');
}

export function filterRecords(records: RecordItem[], query: string, filters: RecordFilters) {
  const normalizedQuery = normalizeSearch(query);
  const start = filters.startDate ? new Date(`${filters.startDate}T00:00:00`) : null;
  const end = filters.endDate ? new Date(`${filters.endDate}T23:59:59`) : null;
  return records.filter(record => {
    const searchable = normalizeSearch(`${record.ticket} ${record.order} ${record.customer} ${record.occurrence}`);
    const openedAt = parseDate(record.openedAt);
    return (!normalizedQuery || searchable.includes(normalizedQuery))
      && (filters.status === 'Todos' || record.status === filters.status)
      && (filters.priority === 'Todas' || record.priority === filters.priority)
      && (filters.owner === 'Todos' || record.owner === filters.owner)
      && (filters.reason === 'Todos' || record.occurrence === filters.reason)
      && (!filters.department || filters.department === 'Todos' || (filters.department === 'unassigned' || filters.department === 'Sem setor definido' ? !record.department : record.department === filters.department))
      && (!start || !openedAt || openedAt >= start)
      && (!end || !openedAt || openedAt <= end)
      && (filters.attention === 'Todos'
        || (filters.attention === 'Requer atenção' && record.operational.attentionReasons.length > 0)
        || (filters.attention === 'Atrasados' && record.operational.isOverdue)
        || (filters.attention === 'Vencem hoje' && record.operational.isDueToday)
        || (filters.attention === 'Próximos do prazo' && record.operational.isNearDue)
        || (filters.attention === 'Sem atualização' && record.operational.isStale)
        || (filters.attention === 'Sem responsável' && record.operational.isUnassigned)
        || (filters.attention === 'Sem prazo' && record.operational.dueState === 'NO_DUE'));
  });
}

function compareText(left: string, right: string) {
  return left.localeCompare(right, 'pt-BR', { numeric: true, sensitivity: 'base' });
}

export function sortRecords(records: RecordItem[], key: SortKey, order: SortOrder) {
  const direction = order === 'asc' ? 1 : -1;
  return [...records].sort((left, right) => {
    if (key === 'default') {
      const overdue = Number(isRecordOverdue(right)) - Number(isRecordOverdue(left));
      if (overdue) return overdue;
      const priority = priorityRank[right.priority] - priorityRank[left.priority];
      if (priority) return priority;
      const due = (parseDate(left.due)?.getTime() ?? Number.MAX_SAFE_INTEGER) - (parseDate(right.due)?.getTime() ?? Number.MAX_SAFE_INTEGER);
      if (due) return due;
      const leftCreated = parseDate(left.createdAt ?? left.openedAt)?.getTime() ?? 0;
      const rightCreated = parseDate(right.createdAt ?? right.openedAt)?.getTime() ?? 0;
      return leftCreated - rightCreated;
    }
    if (key === 'attention') return 0;
    const comparisons: Record<Exclude<SortKey, 'default' | 'attention'>, number> = {
      ticket: compareText(left.ticket, right.ticket),
      customer: compareText(left.customer, right.customer),
      priority: priorityRank[left.priority] - priorityRank[right.priority],
      status: statusRank[left.status] - statusRank[right.status],
      due: (parseDate(left.due)?.getTime() ?? 0) - (parseDate(right.due)?.getTime() ?? 0),
      openedAt: (parseDate(left.openedAt)?.getTime() ?? 0) - (parseDate(right.openedAt)?.getTime() ?? 0),
      createdAt: (parseDate(left.createdAt ?? left.openedAt)?.getTime() ?? 0) - (parseDate(right.createdAt ?? right.openedAt)?.getTime() ?? 0),
      updated: (parseDate(left.updated)?.getTime() ?? 0) - (parseDate(right.updated)?.getTime() ?? 0),
    };
    return comparisons[key] * direction;
  });
}

export function paginateRecords<T>(records: T[], page: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(records.length / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const start = (safePage - 1) * pageSize;
  return { items: records.slice(start, start + pageSize), page: safePage, pageSize, total: records.length, totalPages };
}

export function formatInputDate(value: string) {
  if (!value) return '';
  const [year, month, day] = value.split('-');
  return day && month && year ? `${day}/${month}/${year}` : value;
}
