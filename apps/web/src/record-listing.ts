import type { RecordItem, Status } from './data';

export type AttentionFilter = 'Todos' | 'Requer atenção' | 'Atrasados' | 'Vencem hoje' | 'Próximos do prazo' | 'Sem atualização' | 'Sem responsável' | 'Sem prazo';
export type SortKey = 'default' | 'attention' | 'ticket' | 'customer' | 'priority' | 'status' | 'due' | 'openedAt' | 'updated';
export type SortOrder = 'asc' | 'desc';

export type RecordFilters = {
  status: 'Todos' | Status;
  priority: 'Todas' | RecordItem['priority'];
  owner: string;
  reason: string;
  startDate: string;
  endDate: string;
  attention: AttentionFilter;
};

export const EMPTY_RECORD_FILTERS: RecordFilters = {
  status: 'Todos',
  priority: 'Todas',
  owner: 'Todos',
  reason: 'Todos',
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
  const date = parseBrazilianDate(value);
  if (!date) return { relative: value, full: value };
  const milliseconds = Math.max(0, now.getTime() - date.getTime());
  const minutes = Math.floor(milliseconds / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const relative = minutes < 1 ? 'Agora' : minutes < 60 ? `Há ${minutes} min` : hours < 24 ? `Há ${hours} ${hours === 1 ? 'hora' : 'horas'}` : days < 7 ? `Há ${days} ${days === 1 ? 'dia' : 'dias'}` : date.toLocaleDateString('pt-BR');
  const full = `${date.toLocaleDateString('pt-BR')} às ${date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  return { relative, full };
}

export function getOpenDuration(value: string, now = new Date()) {
  const date = parseBrazilianDate(value);
  if (!date) return '—';
  const hours = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 3_600_000));
  const days = Math.floor(hours / 24);
  return days > 0 ? `${days} ${days === 1 ? 'dia' : 'dias'}` : hours > 0 ? `${hours} ${hours === 1 ? 'hora' : 'horas'}` : 'Menos de 1 hora';
}

export function hasActiveFilters(filters: RecordFilters) {
  return filters.status !== 'Todos' || filters.priority !== 'Todas' || filters.owner !== 'Todos' || filters.reason !== 'Todos' || Boolean(filters.startDate || filters.endDate) || filters.attention !== 'Todos';
}

export function filterRecords(records: RecordItem[], query: string, filters: RecordFilters) {
  const normalizedQuery = normalizeSearch(query);
  const start = filters.startDate ? new Date(`${filters.startDate}T00:00:00`) : null;
  const end = filters.endDate ? new Date(`${filters.endDate}T23:59:59`) : null;
  return records.filter(record => {
    const searchable = normalizeSearch(`${record.ticket} ${record.order} ${record.customer} ${record.occurrence}`);
    const openedAt = parseBrazilianDate(record.openedAt);
    return (!normalizedQuery || searchable.includes(normalizedQuery))
      && (filters.status === 'Todos' || record.status === filters.status)
      && (filters.priority === 'Todas' || record.priority === filters.priority)
      && (filters.owner === 'Todos' || record.owner === filters.owner)
      && (filters.reason === 'Todos' || record.occurrence === filters.reason)
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
      const due = (parseBrazilianDate(left.due)?.getTime() ?? Number.MAX_SAFE_INTEGER) - (parseBrazilianDate(right.due)?.getTime() ?? Number.MAX_SAFE_INTEGER);
      if (due) return due;
      return (parseBrazilianDate(left.openedAt)?.getTime() ?? 0) - (parseBrazilianDate(right.openedAt)?.getTime() ?? 0);
    }
    if (key === 'attention') return 0;
    const comparisons: Record<Exclude<SortKey, 'default' | 'attention'>, number> = {
      ticket: compareText(left.ticket, right.ticket),
      customer: compareText(left.customer, right.customer),
      priority: priorityRank[left.priority] - priorityRank[right.priority],
      status: statusRank[left.status] - statusRank[right.status],
      due: (parseBrazilianDate(left.due)?.getTime() ?? 0) - (parseBrazilianDate(right.due)?.getTime() ?? 0),
      openedAt: (parseBrazilianDate(left.openedAt)?.getTime() ?? 0) - (parseBrazilianDate(right.openedAt)?.getTime() ?? 0),
      updated: (parseBrazilianDate(left.updated)?.getTime() ?? 0) - (parseBrazilianDate(right.updated)?.getTime() ?? 0),
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
