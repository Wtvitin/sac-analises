import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle, ArrowDown, ArrowUp, BarChart3, Bell, CalendarDays, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight,
  CircleUserRound, ClipboardList, Download, Eye, Filter, Home, KanbanSquare,
  LayoutList, Menu, MoreHorizontal, Package, PanelLeftClose, PanelLeftOpen, Plus, Search,
  KeyRound, LogOut, RefreshCw, Settings2, SlidersHorizontal, TrendingUp, UserCheck, Users, X
} from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis
} from 'recharts';
import { records as initialRecords, type RecordItem, type Status } from './data';
import { apiRequest, type AuthUser } from './api';
import { useRecordList } from './use-record-list';
import { CatalogPage } from './CatalogPage';
import { SacRecordForm, type DetailedRecord } from './SacRecordForm';
import { CaseOperationsModal, type OperationalRecord } from './CaseOperationsModal';
import { NotificationCenter } from './NotificationCenter';
import {
  EMPTY_RECORD_FILTERS, formatInputDate, getDueLabel, getOpenDuration, getRelativeUpdate, hasActiveFilters,
  isRecordOverdue, paginateRecords, type RecordFilters, type SortKey, type SortOrder,
} from './record-listing';

type Page = 'Visão geral' | 'Registros' | 'Dashboards' | 'Equipe' | 'Cadastros';
const nav: { label: Page; icon: typeof Home }[] = [
  { label: 'Visão geral', icon: Home }, { label: 'Registros', icon: ClipboardList },
  { label: 'Dashboards', icon: BarChart3 }, { label: 'Equipe', icon: Users },
  { label: 'Cadastros', icon: Settings2 },
];
const owners: string[] = [];
const reasonNames: string[] = [];

function slug(value: string) { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replaceAll(' ', '-').toLowerCase(); }
function initials(name: string) { return name === 'Sem responsável' ? '?' : name.split(' ').map(v => v[0]).slice(0, 2).join(''); }
function isOverdue(record: RecordItem) { return isRecordOverdue(record); }
type ApiRecord = { id: string; ticket: string; orderNumber: string; description: string; priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'; openedAt: string; dueAt: string; updatedAt: string; identifiedCause?: string | null; correctiveAction?: string | null; responsibleArea?: string | null; customer: { name: string }; reason: { name: string }; assignee?: { name: string } | null; operational: RecordItem['operational'] };
const priorityMap = { LOW: 'Baixa', MEDIUM: 'Média', HIGH: 'Alta', CRITICAL: 'Crítica' } as const;
const statusMap = { PENDING: 'Pendente', IN_PROGRESS: 'Em andamento', COMPLETED: 'Concluído', CANCELLED: 'Cancelado' } as const;
function mapApiRecord(record: ApiRecord): RecordItem { return { id: record.id, ticket: record.ticket, customer: record.customer.name, order: record.orderNumber, occurrence: record.reason.name, owner: record.assignee?.name ?? 'Sem responsável', status: statusMap[record.status], due: new Date(record.dueAt).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }), updated: new Date(record.operational.lastOperationalActivityAt).toLocaleString('pt-BR'), openedAt: new Date(record.openedAt).toLocaleString('pt-BR'), priority: priorityMap[record.priority], description: record.description, identifiedCause: record.identifiedCause ?? undefined, correctiveAction: record.correctiveAction ?? undefined, responsibleArea: record.responsibleArea ?? undefined, operational: record.operational }; }

function StatusBadge({ status }: { status: Status }) {
  return <span className={`badge badge-${slug(status)}`}><i />{status}</span>;
}

type PageHeaderProps = {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  primaryAction?: ReactNode;
  secondaryActions?: ReactNode;
  breadcrumb?: ReactNode;
};

function PageHeader({ title, subtitle, action, primaryAction, secondaryActions, breadcrumb }: PageHeaderProps) {
  const actions = action ?? (primaryAction || secondaryActions ? <>{secondaryActions}{primaryAction}</> : null);
  return <header className="page-header page-title page-title-row">
    <div className="page-header-copy">{breadcrumb && <nav className="page-breadcrumb" aria-label="Breadcrumb">{breadcrumb}</nav>}<h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
    {actions && <div className="page-header-actions">{actions}</div>}
  </header>;
}

function SearchInput({ value, onChange, onClear, placeholder, label, className = '' }: { value: string; onChange: (value: string) => void; onClear?: () => void; placeholder: string; label: string; className?: string }) {
  return <div className={`search-input ${className}`.trim()}><Search aria-hidden="true" /><input value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} aria-label={label} />{value && <button type="button" className="search-clear" aria-label={`Limpar ${label.toLowerCase()}`} onClick={onClear ?? (() => onChange(''))}><X aria-hidden="true" /></button>}</div>;
}

function PriorityBadge({ priority }: { priority: RecordItem['priority'] }) {
  return <span className={`priority priority-${slug(priority)}`}>{priority}</span>;
}

const attentionLabels: Record<RecordItem['operational']['attentionReasons'][number], string> = { OVERDUE: 'Atrasado', DUE_TODAY: 'Vence hoje', NEAR_DUE: 'Prazo próximo', HIGH_PRIORITY: 'Alta prioridade', UNASSIGNED: 'Sem responsável', STALE: 'Sem atualização', NO_DUE: 'Sem prazo' };
function AttentionBadges({ record }: { record: RecordItem }) {
  const reasons = record.operational.attentionReasons; if (!reasons.length) return null;
  const visible = reasons.slice(0, 2); const hidden = reasons.slice(2); const full = reasons.map(reason => attentionLabels[reason]).join(', ');
  return <span className="attention-badges" aria-label={`Atenção: ${full}`}>{visible.map(reason => <span key={reason} className={`attention-badge attention-${reason.toLowerCase().replace('_', '-')}`}>{attentionLabels[reason]}</span>)}{hidden.length > 0 && <span className="attention-more" title={hidden.map(reason => attentionLabels[reason]).join(', ')} aria-label={`Mais ${hidden.length}: ${hidden.map(reason => attentionLabels[reason]).join(', ')}`}>+{hidden.length}</span>}</span>;
}
function AttentionQueueItem({ record, onSelect }: { record: RecordItem; onSelect: (record: RecordItem) => void }) {
  const activity = getRelativeUpdate(record.updated);
  return <button type="button" onClick={() => onSelect(record)} aria-label={`Abrir ${record.ticket}`}><span><strong>{record.ticket}</strong><small>{record.customer} · Pedido {record.order}</small></span><span className="attention-context"><small>{record.owner} · {record.status}</small><AttentionBadges record={record} /></span><span className="attention-dates"><time className={record.operational.isOverdue ? 'overdue' : ''}>{getDueLabel(record)} · {record.due}</time><small title={activity.full}>Atividade {activity.relative.toLocaleLowerCase('pt-BR')}</small></span></button>;
}

function RowActions({ record, onView, onEdit }: { record: RecordItem; onView: (record: RecordItem) => void; onEdit?: (record: RecordItem) => void }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = (restoreFocus = false) => { setOpen(false); if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus()); };
  const toggle = () => {
    if (open) { close(); return; }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const width = 168; const height = onEdit ? 88 : 48; const gap = 6;
      setPosition({ left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)), top: rect.bottom + height + gap > window.innerHeight ? Math.max(8, rect.top - height - gap) : rect.bottom + gap });
    }
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus());
    const pointer = (event: MouseEvent) => { const target = event.target as Node; if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) close(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close(true); };
    const dismiss = () => close();
    document.addEventListener('mousedown', pointer); window.addEventListener('keydown', key); window.addEventListener('resize', dismiss); window.addEventListener('scroll', dismiss, true);
    return () => { document.removeEventListener('mousedown', pointer); window.removeEventListener('keydown', key); window.removeEventListener('resize', dismiss); window.removeEventListener('scroll', dismiss, true); };
  }, [open]);
  return <><button ref={triggerRef} type="button" className="row-actions-trigger" aria-label={`Ações de ${record.ticket}`} aria-haspopup="menu" aria-expanded={open} onClick={event => { event.stopPropagation(); toggle(); }}><MoreHorizontal aria-hidden="true" /></button>{open && createPortal(<div ref={menuRef} className="row-actions-menu" role="menu" aria-label={`Ações de ${record.ticket}`} style={position}><button type="button" role="menuitem" onClick={() => { close(); onView(record); }}><Eye aria-hidden="true" />Visualizar</button>{onEdit && <button type="button" role="menuitem" onClick={() => { close(); onEdit(record); }}><Settings2 aria-hidden="true" />Editar</button>}</div>, document.body)}</>;
}

function SortableHeader({ label, column, active, order, onSort, className = '' }: { label: string; column: Exclude<SortKey, 'default'>; active: boolean; order: SortOrder; onSort: (column: Exclude<SortKey, 'default'>) => void; className?: string }) {
  return <th className={className} aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}><button type="button" className={active ? 'sort-active' : ''} onClick={() => onSort(column)}>{label}{active ? (order === 'asc' ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />) : <span className="sort-placeholder" aria-hidden="true" />}</button></th>;
}

function RecordsTable({ records, onSelect, onEdit, selectedTicket, sortKey, sortOrder, onSort }: { records: RecordItem[]; onSelect: (record: RecordItem) => void; onEdit?: (record: RecordItem) => void; selectedTicket?: string; sortKey: SortKey; sortOrder: SortOrder; onSort: (column: Exclude<SortKey, 'default'>) => void }) {
  return <div className="table-wrap desktop-records-table"><table className="records-table"><thead><tr><SortableHeader label="Ticket" column="ticket" active={sortKey === 'ticket'} order={sortOrder} onSort={onSort} /><SortableHeader label="Cliente e pedido" column="customer" active={sortKey === 'customer'} order={sortOrder} onSort={onSort} /><th data-column="reason">Motivo</th><th>Responsável</th><SortableHeader label="Prioridade" column="priority" active={sortKey === 'priority'} order={sortOrder} onSort={onSort} className="column-priority" /><SortableHeader label="Status" column="status" active={sortKey === 'status'} order={sortOrder} onSort={onSort} /><SortableHeader label="Prazo" column="due" active={sortKey === 'due'} order={sortOrder} onSort={onSort} /><SortableHeader label="Tempo em aberto" column="openedAt" active={sortKey === 'openedAt'} order={sortOrder} onSort={onSort} className="column-opened" /><SortableHeader label="Última atualização" column="updated" active={sortKey === 'updated' || sortKey === 'default'} order={sortKey === 'default' ? 'desc' : sortOrder} onSort={onSort} className="column-updated" /><th className="column-actions"><span className="sr-only">Ações</span></th></tr></thead>
    <tbody>{records.map(record => { const dueLabel = getDueLabel(record); const update = getRelativeUpdate(record.updated); const opened = getRelativeUpdate(record.openedAt); return <tr key={record.ticket} className={selectedTicket === record.ticket ? 'is-selected' : ''} aria-selected={selectedTicket === record.ticket} onClick={() => onSelect(record)} tabIndex={0} onKeyDown={event => { if (event.key === 'Enter' && event.target === event.currentTarget) onSelect(record); }}>
      <td><strong title={record.ticket}>{record.ticket}</strong></td><td><span className="cell-primary" title={record.customer}>{record.customer}</span><small>Pedido {record.order}</small></td><td data-column="reason"><span className="cell-truncate" title={record.occurrence}>{record.occurrence}</span></td>
      <td><span className={`owner${record.owner === 'Sem responsável' ? ' owner-unassigned' : ''}`}><span className="avatar">{initials(record.owner)}</span><span title={record.owner}>{record.owner}</span></span></td><td className="column-priority"><PriorityBadge priority={record.priority} /></td><td><StatusBadge status={record.status} /></td>
      <td><time className={isOverdue(record) ? 'due-date overdue' : 'due-date'}>{record.due}</time>{dueLabel && <small className={isOverdue(record) ? 'due-label overdue' : 'due-label'}>{dueLabel}</small>}<AttentionBadges record={record} /></td><td className="column-opened"><time title={opened.full}>{getOpenDuration(record.openedAt)}</time></td><td className="column-updated"><time tabIndex={0} className="accessible-time" data-tooltip={update.full} title={update.full} aria-label={`${update.relative}. ${update.full}`}>{update.relative}</time></td>
      <td className="column-actions" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}><RowActions record={record} onView={onSelect} onEdit={onEdit} /></td>
    </tr>; })}</tbody></table></div>;
}

function MobileRecordCard({ record, onSelect, onEdit, selected }: { record: RecordItem; onSelect: (record: RecordItem) => void; onEdit?: (record: RecordItem) => void; selected: boolean }) {
  const dueLabel = getDueLabel(record); const update = getRelativeUpdate(record.updated);
  return <article className={`mobile-record-card${selected ? ' is-selected' : ''}`} tabIndex={0} onClick={() => onSelect(record)} onKeyDown={event => { if (event.key === 'Enter' && event.target === event.currentTarget) onSelect(record); }}><header><strong>{record.ticket}</strong><RowActions record={record} onView={onSelect} onEdit={onEdit} /></header><AttentionBadges record={record} /><div className="mobile-record-client"><strong title={record.customer}>{record.customer}</strong><span>Pedido {record.order}</span></div><dl><div><dt>Motivo</dt><dd title={record.occurrence}>{record.occurrence}</dd></div><div><dt>Responsável</dt><dd className={record.owner === 'Sem responsável' ? 'owner-unassigned-text' : ''}>{record.owner}</dd></div><div><dt>Prioridade</dt><dd><PriorityBadge priority={record.priority} /></dd></div><div><dt>Status</dt><dd><StatusBadge status={record.status} /></dd></div><div><dt>Prazo</dt><dd><time className={isOverdue(record) ? 'overdue' : ''}>{record.due}</time>{dueLabel && <small>{dueLabel}</small>}</dd></div><div><dt>Atualização</dt><dd><time tabIndex={0} className="accessible-time" data-tooltip={update.full} title={update.full} aria-label={`${update.relative}. ${update.full}`}>{update.relative}</time></dd></div></dl></article>;
}

function RecordList({ records, onSelect, onEdit, selectedTicket, sortKey, sortOrder, onSort }: { records: RecordItem[]; onSelect: (record: RecordItem) => void; onEdit?: (record: RecordItem) => void; selectedTicket?: string; sortKey: SortKey; sortOrder: SortOrder; onSort: (column: Exclude<SortKey, 'default'>) => void }) {
  return <><RecordsTable records={records} onSelect={onSelect} onEdit={onEdit} selectedTicket={selectedTicket} sortKey={sortKey} sortOrder={sortOrder} onSort={onSort} /><div className="mobile-record-list">{records.map(record => <MobileRecordCard key={record.ticket} record={record} onSelect={onSelect} onEdit={onEdit} selected={selectedTicket === record.ticket} />)}</div></>;
}

function LoadingState() {
  return <div className="records-loading" role="status" aria-live="polite"><span className="sr-only">Carregando registros</span>{Array.from({ length: 5 }, (_, index) => <div className="skeleton-row" key={index}>{Array.from({ length: 6 }, (__, cell) => <i key={cell} />)}</div>)}</div>;
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return <div className="list-error" role="alert"><AlertTriangle aria-hidden="true" /><div><strong>Não foi possível carregar os registros</strong><span>Verifique sua conexão e tente novamente.</span></div><button type="button" className="secondary" onClick={onRetry}><RefreshCw aria-hidden="true" />Tentar novamente</button></div>;
}

function EmptyState({ icon: Icon, title, text, action, compact = false }: { icon: typeof Package; title: string; text: string; action?: ReactNode; compact?: boolean }) {
  return <div className={`empty-state${compact ? ' empty-state-compact' : ''}`}><Icon aria-hidden="true" /><strong>{title}</strong><span>{text}</span>{action && <div className="empty-state-actions">{action}</div>}</div>;
}

function FilterPanel({ filters, onChange, owners: ownerOptions, reasons }: { filters: RecordFilters; onChange: (filters: RecordFilters) => void; owners: string[]; reasons: string[] }) {
  const panel = useRef<HTMLDetailsElement>(null);
  const closePanel = () => { if (panel.current) { panel.current.open = false; panel.current.querySelector('summary')?.focus(); } };
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (panel.current?.open && !panel.current.contains(event.target as Node)) panel.current.open = false; };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && panel.current?.open) closePanel(); };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, []);
  const activeCount = [filters.status !== 'Todos', filters.priority !== 'Todas', filters.owner !== 'Todos', filters.reason !== 'Todos', Boolean(filters.startDate), Boolean(filters.endDate), filters.attention !== 'Todos'].filter(Boolean).length;
  const invalidPeriod = Boolean(filters.startDate && filters.endDate && filters.startDate > filters.endDate);
  const change = <Key extends keyof RecordFilters>(key: Key, value: RecordFilters[Key]) => onChange({ ...filters, [key]: value });
  return <details ref={panel} className="filter-panel"><summary><SlidersHorizontal aria-hidden="true" />Filtros{activeCount > 0 && <span>{activeCount}</span>}</summary><div className="filter-panel-content"><button type="button" className="filter-close secondary" onClick={closePanel}><X aria-hidden="true" />Fechar filtros</button><div className="filter-grid"><label>Status<select value={filters.status} onChange={event => change('status', event.target.value as RecordFilters['status'])}><option>Todos</option><option>Pendente</option><option>Em andamento</option><option>Concluído</option><option>Cancelado</option></select></label><label>Prioridade<select value={filters.priority} onChange={event => change('priority', event.target.value as RecordFilters['priority'])}><option>Todas</option><option>Baixa</option><option>Média</option><option>Alta</option><option>Crítica</option></select></label><label>Responsável<select value={filters.owner} onChange={event => change('owner', event.target.value)}><option>Todos</option>{ownerOptions.map(value => <option key={value}>{value}</option>)}</select></label><label>Motivo<select value={filters.reason} onChange={event => change('reason', event.target.value)}><option>Todos</option>{reasons.map(value => <option key={value}>{value}</option>)}</select></label><label>Atenção operacional<select value={filters.attention} onChange={event => change('attention', event.target.value as RecordFilters['attention'])}><option>Todos</option><option>Requer atenção</option><option>Atrasados</option><option>Vencem hoje</option><option>Próximos do prazo</option><option>Sem atualização</option><option>Sem responsável</option><option>Sem prazo</option></select></label><label>Período inicial<input type="date" value={filters.startDate} aria-invalid={invalidPeriod} onChange={event => change('startDate', event.target.value)} /></label><label>Período final<input type="date" value={filters.endDate} aria-invalid={invalidPeriod} onChange={event => change('endDate', event.target.value)} /></label></div>{invalidPeriod && <p className="filter-validation" role="alert">A data inicial deve ser anterior ou igual à data final.</p>}<button type="button" className="filter-clear" disabled={!activeCount} onClick={() => onChange({ ...EMPTY_RECORD_FILTERS })}>Limpar filtros</button></div></details>;
}

function ActiveFilterChips({ query, filters, onClearQuery, onChange }: { query: string; filters: RecordFilters; onClearQuery: () => void; onChange: (filters: RecordFilters) => void }) {
  const items: { key: keyof RecordFilters | 'query'; label: string }[] = [];
  if (query) items.push({ key: 'query', label: `Busca: ${query}` });
  if (filters.status !== 'Todos') items.push({ key: 'status', label: `Status: ${filters.status}` });
  if (filters.priority !== 'Todas') items.push({ key: 'priority', label: `Prioridade: ${filters.priority}` });
  if (filters.owner !== 'Todos') items.push({ key: 'owner', label: `Responsável: ${filters.owner}` });
  if (filters.reason !== 'Todos') items.push({ key: 'reason', label: `Motivo: ${filters.reason}` });
  if (filters.startDate) items.push({ key: 'startDate', label: `Desde ${formatInputDate(filters.startDate)}` });
  if (filters.endDate) items.push({ key: 'endDate', label: `Até ${formatInputDate(filters.endDate)}` });
  if (filters.attention !== 'Todos') items.push({ key: 'attention', label: `Atenção: ${filters.attention}` });
  if (!items.length) return null;
  const remove = (key: typeof items[number]['key']) => {
    if (key === 'query') { onClearQuery(); return; }
    const defaults = EMPTY_RECORD_FILTERS[key];
    onChange({ ...filters, [key]: defaults });
  };
  return <div className="active-filter-chips" aria-label="Filtros ativos">{items.map(item => <button type="button" key={item.key} onClick={() => remove(item.key)}>{item.label}<X aria-hidden="true" /></button>)}{items.length > 1 && <button type="button" className="clear-all-chips" onClick={() => { onClearQuery(); onChange({ ...EMPTY_RECORD_FILTERS }); }}>Limpar tudo</button>}</div>;
}

function Pagination({ total, page, pageSize, onPageChange, onPageSizeChange, noun = 'casos' }: { total: number; page: number; pageSize: number; onPageChange: (page: number) => void; onPageSizeChange: (pageSize: number) => void; noun?: string }) {
  if (total === 0) return null;
  const totalPages = Math.ceil(total / pageSize); const start = (page - 1) * pageSize + 1; const end = Math.min(page * pageSize, total);
  return <footer className="pagination"><span>{totalPages > 1 ? `Mostrando ${start}–${end} de ${total} ${noun}` : `${total} ${noun === 'casos' && total === 1 ? 'caso' : noun}`}</span><label>Por página<select value={pageSize} onChange={event => onPageSizeChange(Number(event.target.value))}>{[10, 20, 50, 100].map(value => <option value={value} key={value}>{value}</option>)}</select></label>{totalPages > 1 && <nav aria-label="Paginação dos registros"><button type="button" disabled={page === 1} onClick={() => onPageChange(page - 1)} aria-label="Página anterior"><ChevronLeft aria-hidden="true" /></button><span>Página {page} de {totalPages}</span><button type="button" disabled={page === totalPages} onClick={() => onPageChange(page + 1)} aria-label="Próxima página"><ChevronRight aria-hidden="true" /></button></nav>}</footer>;
}

function Overview({ refresh, query, status, setStatus, onSelect, selectedTicket, onClearQuery, onViewAttention }: { refresh: unknown; query: string; status: Status | null; setStatus: (value: Status | null) => void; onSelect: (record: RecordItem) => void; selectedTicket?: string; onClearQuery: () => void; onViewAttention: (filter: RecordFilters['attention']) => void }) {
  const [pageSize, setPageSize] = useState(20); const [sortKey, setSortKey] = useState<SortKey>('default'); const [sortOrder, setSortOrder] = useState<SortOrder>('asc');
  const scope = JSON.stringify([query, status, sortKey, sortOrder, pageSize]);
  const [cursor, setCursor] = useState({ scope, page: 1 });
  const page = cursor.scope === scope ? cursor.page : 1;
  const setPage = (next: number) => setCursor({ scope, page: next });
  const listing = useRecordList<ApiRecord>(query, { ...EMPTY_RECORD_FILTERS, status: status ?? 'Todos' }, sortKey, sortOrder, page, pageSize, refresh, mapApiRecord);
  const attention = useRecordList<ApiRecord>('', { ...EMPTY_RECORD_FILTERS, attention: 'Requer atenção' }, 'attention', 'asc', 1, 5, refresh, mapApiRecord);
  const { loading, error, onRetry } = listing;
  const filtered = listing.items;
  const paginated = { items: listing.items, total: listing.total, page };
  useEffect(() => { if (!loading && !error && page > Math.max(1, Math.ceil(listing.total / pageSize))) setCursor({ scope, page: Math.max(1, Math.ceil(listing.total / pageSize)) }); }, [listing.total, loading, error, page, pageSize, scope]);
  const handleSort = (column: Exclude<SortKey, 'default'>) => { if (sortKey === column) setSortOrder(value => value === 'asc' ? 'desc' : 'asc'); else { setSortKey(column); setSortOrder('asc'); } };
  const counts = { Pendente: listing.counts.PENDING ?? 0, 'Em andamento': listing.counts.IN_PROGRESS ?? 0, Concluído: listing.counts.COMPLETED ?? 0 };
  return <><PageHeader title="Visão geral" subtitle="Acompanhe o andamento dos casos e saiba quem está responsável por cada um." />
    <section className="stats">{(['Pendente', 'Em andamento', 'Concluído'] as const).map((value, index) => <button key={value} onClick={() => setStatus(status === value ? null : value)} className={`${status === value ? 'selected ' : ''}stat stat-${index}`}><span className="stat-icon">{index === 0 ? <ClipboardList /> : index === 1 ? <Bell /> : <CheckCircle2 />}</span><span><strong>{counts[value]}</strong><small>{value === 'Pendente' ? 'Pendentes' : value}</small></span></button>)}<button className="stat stat-overdue" onClick={() => onViewAttention('Atrasados')}><span className="stat-icon"><AlertTriangle /></span><span><strong>{listing.counts.overdue ?? 0}</strong><small>Atrasados</small></span></button></section>
    <section className="attention-queue" aria-labelledby="attention-title"><header><div><h2 id="attention-title">Requer atenção</h2><p>Casos ordenados por urgência operacional.</p></div><button type="button" className="secondary" onClick={() => onViewAttention('Requer atenção')}>Ver todos</button></header>{attention.loading ? <LoadingState /> : attention.error ? <ErrorState onRetry={attention.onRetry} /> : attention.items.length === 0 ? <EmptyState compact icon={CheckCircle2} title="Nenhum caso requer atenção" text="A fila está em dia neste momento." /> : <div className="attention-list">{attention.items.map(record => <AttentionQueueItem key={record.id} record={record} onSelect={onSelect} />)}</div>}</section>
    <section className="table-card records-surface">{filtered.length > 0 && <div className="table-title"><h2>Acompanhamento dos casos</h2><span className="helper-text">Clique em uma linha para ver detalhes</span></div>}{loading ? <LoadingState /> : error ? <ErrorState onRetry={onRetry} /> : filtered.length === 0 ? (!query && !status ? <EmptyState compact icon={ClipboardList} title="Nenhum caso em acompanhamento" text="Os casos pendentes e em andamento aparecerão aqui." /> : <EmptyState compact icon={Search} title="Nenhum resultado encontrado" text="Tente ajustar a busca ou remover alguns filtros." action={<div>{query && <button type="button" className="secondary" onClick={onClearQuery}>Limpar busca</button>}{status && <button type="button" className="secondary" onClick={() => setStatus(null)}>Limpar filtro</button>}</div>} />) : <><RecordList records={paginated.items} onSelect={onSelect} selectedTicket={selectedTicket} sortKey={sortKey} sortOrder={sortOrder} onSort={handleSort} /><Pagination total={paginated.total} page={paginated.page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} /></>}</section>
  </>;
}

function RecordsPage({ refresh, requestedAttention, query, onSelect, onEdit, selectedTicket, onClearQuery, canCreate, onCreate }: { refresh: unknown; requestedAttention?: RecordFilters['attention']; query: string; onSelect: (record: RecordItem) => void; onEdit: (record: RecordItem) => void; selectedTicket?: string; onClearQuery: () => void; canCreate: boolean; onCreate: () => void }) {
  const [view, setView] = useState<'table' | 'kanban'>('table'); const [filters, setFilters] = useState<RecordFilters>({ ...EMPTY_RECORD_FILTERS, attention: requestedAttention ?? 'Todos' }); const [sortKey, setSortKey] = useState<SortKey>(requestedAttention ? 'attention' : 'default'); const [sortOrder, setSortOrder] = useState<SortOrder>('asc'); const [pageSize, setPageSize] = useState(20);
  const scope = JSON.stringify([query, filters, sortKey, sortOrder, pageSize]);
  const [cursor, setCursor] = useState({ scope, page: 1 });
  const page = cursor.scope === scope ? cursor.page : 1;
  const setPage = (next: number) => setCursor({ scope, page: next });
  const listing = useRecordList<ApiRecord>(query, filters, sortKey, sortOrder, page, pageSize, refresh, mapApiRecord);
  const { loading, error, onRetry } = listing;
  const filtered = listing.items; const sorted = listing.items; const paginated = { items: listing.items, total: listing.total, page };
  const ownerOptions = listing.options.owners;
  const reasonOptions = listing.options.reasons;
  const filteredState = Boolean(query) || hasActiveFilters(filters);
  useEffect(() => { if (!loading && !error && page > Math.max(1, Math.ceil(listing.total / pageSize))) setCursor({ scope, page: Math.max(1, Math.ceil(listing.total / pageSize)) }); }, [listing.total, loading, error, page, pageSize, scope]);
  const handleSort = (column: Exclude<SortKey, 'default'>) => { if (sortKey === column) setSortOrder(value => value === 'asc' ? 'desc' : 'asc'); else { setSortKey(column); setSortOrder('asc'); } };
  const clearFilters = () => setFilters({ ...EMPTY_RECORD_FILTERS });
  const emptyActions = filteredState ? <div>{query && <button type="button" className="secondary" onClick={onClearQuery}>Limpar busca</button>}{hasActiveFilters(filters) && <button type="button" className="secondary" onClick={clearFilters}>Limpar filtros</button>}</div> : canCreate ? <button type="button" className="primary" onClick={onCreate}><Plus aria-hidden="true" />Criar primeiro registro</button> : undefined;
  return <><PageHeader title="Registros" subtitle="Consulte, organize e acompanhe todas as ocorrências." action={<div className="view-switch"><button className={view === 'table' ? 'active' : ''} onClick={() => setView('table')}><LayoutList />Tabela</button><button className={view === 'kanban' ? 'active' : ''} onClick={() => setView('kanban')}><KanbanSquare />Kanban</button></div>} />
    <section className="table-toolbar"><FilterPanel filters={filters} onChange={setFilters} owners={ownerOptions} reasons={reasonOptions} /><label className="list-sort">Ordenar por<select value={sortKey} onChange={event => { setSortKey(event.target.value as SortKey); setSortOrder('asc'); }}><option value="default">Última atualização (mais recente)</option><option value="attention">Atenção operacional</option><option value="ticket">Ticket</option><option value="customer">Cliente</option><option value="priority">Prioridade</option><option value="status">Status</option><option value="due">Prazo</option><option value="openedAt">Data de abertura</option><option value="updated">Última atualização</option></select></label>{sortKey !== 'default' && <button type="button" className="sort-order" aria-label={sortOrder === 'asc' ? 'Ordenação crescente' : 'Ordenação decrescente'} onClick={() => setSortOrder(value => value === 'asc' ? 'desc' : 'asc')}>{sortOrder === 'asc' ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}</button>}<span className="result-count" aria-live="polite">{listing.total} {listing.total === 1 ? 'registro encontrado' : 'registros encontrados'}</span></section>
    <ActiveFilterChips query={query} filters={filters} onClearQuery={onClearQuery} onChange={setFilters} />
    {view === 'table' || loading || error ? <section className="table-card records-surface">{loading ? <LoadingState /> : error ? <ErrorState onRetry={onRetry} /> : filtered.length === 0 ? <EmptyState compact icon={filteredState ? Search : ClipboardList} title={filteredState ? 'Nenhum resultado encontrado' : 'Nenhum caso cadastrado'} text={filteredState ? 'Tente ajustar a busca ou remover alguns filtros.' : 'Os registros de SAC aparecerão aqui conforme forem criados.'} action={emptyActions} /> : <><RecordList records={paginated.items} onSelect={onSelect} onEdit={onEdit} selectedTicket={selectedTicket} sortKey={sortKey} sortOrder={sortOrder} onSort={handleSort} /><Pagination total={paginated.total} page={paginated.page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} /></>}</section> : filtered.length === 0 ? <section className="table-card records-surface"><EmptyState compact icon={filteredState ? Search : ClipboardList} title={filteredState ? 'Nenhum resultado encontrado' : 'Nenhum caso cadastrado'} text={filteredState ? 'Tente ajustar a busca ou remover alguns filtros.' : 'Os registros de SAC aparecerão aqui conforme forem criados.'} action={emptyActions} /></section> : <><div className="kanban">{(['Pendente', 'Em andamento', 'Concluído', 'Cancelado'] as Status[]).map(column => <section key={column}><header><StatusBadge status={column} /><strong>{sorted.filter(record => record.status === column).length}</strong></header><div>{sorted.filter(record => record.status === column).map(record => <article key={record.ticket} onClick={() => onSelect(record)}><div><strong>{record.ticket}</strong><span className={`priority-dot priority-${slug(record.priority)}`} /></div><h3>{record.occurrence}</h3><p>{record.customer}<span>Pedido {record.order}</span></p><footer><span className="owner"><span className="avatar">{initials(record.owner)}</span>{record.owner}</span><time className={isOverdue(record) ? 'overdue' : ''}>{record.due}</time></footer></article>)}</div></section>)}</div><Pagination total={listing.total} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} /></>}
  </>;
}

function DashboardsPage({ records }: { records: RecordItem[] }) {
  const [period, setPeriod] = useState('Últimos 6 meses'); const [owner, setOwner] = useState('Todos');
  const reasonChart = Object.entries(records.reduce<Record<string, number>>((acc, record) => ({ ...acc, [record.occurrence]: (acc[record.occurrence] ?? 0) + 1 }), {})).map(([name, total]) => ({ name, total }));
  const trendChart: { month: string; abertos: number; concluidos: number }[] = [];
  const pie = [{ name: 'Pendentes', value: records.filter(r => r.status === 'Pendente').length, color: '#bd075e' }, { name: 'Em andamento', value: records.filter(r => r.status === 'Em andamento').length, color: '#1678d3' }, { name: 'Concluídos', value: records.filter(r => r.status === 'Concluído').length, color: '#15945f' }];
  const metrics = [{ label: 'Pendentes', value: pie[0].value, icon: ClipboardList }, { label: 'Em andamento', value: pie[1].value, icon: TrendingUp }, { label: 'Concluídos', value: pie[2].value, icon: CheckCircle2 }, { label: 'Alta prioridade', value: records.filter(r => r.priority === 'Alta' || r.priority === 'Crítica').length, icon: AlertTriangle }, { label: 'Vencidos', value: records.filter(isOverdue).length, icon: CalendarDays }, { label: 'Tempo médio', value: records.length ? 'Calculando' : '—', icon: BarChart3 }];
  return <><PageHeader title="Dashboards" subtitle="Analise causas, tendências e desempenho da operação." action={<button className="secondary"><Download />Exportar CSV</button>} />
    <section className="filter-bar dashboard-filters"><label>Período<select value={period} onChange={e => setPeriod(e.target.value)}><option>Últimos 30 dias</option><option>Últimos 3 meses</option><option>Últimos 6 meses</option><option>Este ano</option></select></label><label>Responsável<select value={owner} onChange={e => setOwner(e.target.value)}><option>Todos</option>{owners.map(value => <option key={value}>{value}</option>)}</select></label><label>Motivo<select><option>Todos os motivos</option>{reasonNames.map(value => <option key={value}>{value}</option>)}</select></label></section>
    <section className="metric-grid">{metrics.map(({ label, value, icon: Icon }) => <article key={label}><span><Icon /></span><div><small>{label}</small><strong>{value}</strong></div></article>)}</section>
    {!records.length ? <section className="table-card"><EmptyState icon={BarChart3} title="Ainda não existem dados suficientes para gerar este relatório" text="Os gráficos serão apresentados quando os primeiros casos forem cadastrados." /></section> : <section className="charts-grid"><ChartCard title="Casos por motivo" subtitle="Quantidade no período"><ResponsiveContainer width="100%" height={270}><BarChart data={reasonChart} layout="vertical" margin={{ left: 20 }}><CartesianGrid strokeDasharray="3 3" horizontal={false} /><XAxis type="number" hide /><YAxis dataKey="name" type="category" width={110} tick={{ fontSize: 11 }} /><Tooltip /><Bar dataKey="total" fill="#1678d3" radius={[0, 5, 5, 0]} /></BarChart></ResponsiveContainer></ChartCard>
      <ChartCard title="Casos por status" subtitle="Distribuição atual"><ResponsiveContainer width="100%" height={270}><PieChart><Pie data={pie} dataKey="value" nameKey="name" innerRadius={62} outerRadius={92} paddingAngle={4}>{pie.map(item => <Cell key={item.name} fill={item.color} />)}</Pie><Tooltip /><Legend /></PieChart></ResponsiveContainer></ChartCard>
      <div className="chart-wide"><ChartCard title="Evolução de abertura e conclusão" subtitle={`${period} · ${owner}`}><ResponsiveContainer width="100%" height={290}><LineChart data={trendChart}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="month" /><YAxis /><Tooltip /><Legend /><Line type="monotone" dataKey="abertos" name="Abertos" stroke="#bd075e" strokeWidth={3} /><Line type="monotone" dataKey="concluidos" name="Concluídos" stroke="#15945f" strokeWidth={3} /></LineChart></ResponsiveContainer></ChartCard></div></section>}
  </>;
}

function ChartCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) { return <article className="chart-card"><header><div><h2>{title}</h2><p>{subtitle}</p></div><button className="icon-btn"><MoreHorizontal /></button></header>{children}</article>; }

const team: { name: string; role: string; active: boolean; pending: number; activeCases: number; completed: number; load: number }[] = [];

function TeamPage() {
  const [query, setQuery] = useState('');
  const filteredTeam = team.filter(user => `${user.name} ${user.role}`.toLowerCase().includes(query.toLowerCase()));
  return <><PageHeader title="Equipe" subtitle="Gerencie usuários, disponibilidade e distribuição de trabalho." action={<button className="primary"><Plus />Novo usuário</button>} />
    <section className="team-summary"><article><UserCheck /><div><strong>0</strong><span>Usuários ativos</span></div></article><article><ClipboardList /><div><strong>0</strong><span>Casos em aberto</span></div></article><article><AlertTriangle /><div><strong>0</strong><span>Sem responsável</span></div></article></section>
    <section className="table-card"><div className="table-title"><h2>Membros da equipe</h2><div><SearchInput className="table-search" value={query} onChange={setQuery} placeholder="Buscar usuário..." label="Buscar usuário" /><button><Filter />Filtros</button></div></div>{filteredTeam.length ? <div className="team-table"><table><thead><tr><th>Usuário</th><th>Perfil</th><th>Status</th><th>Pendentes</th><th>Em andamento</th><th>Concluídos</th><th>Carga atual</th><th /></tr></thead><tbody>{filteredTeam.map(user => <tr key={user.name}><td><span className="owner"><span className="avatar team-avatar">{initials(user.name)}</span><span><strong>{user.name}</strong></span></span></td><td>{user.role}</td><td><span className={`availability ${user.active ? 'online' : ''}`}><i />{user.active ? 'Ativo' : 'Inativo'}</span></td><td>{user.pending}</td><td>{user.activeCases}</td><td>{user.completed}</td><td><div className="load"><div><i style={{ width: `${user.load}%` }} /></div><span>{user.load}%</span></div></td><td><button className="icon-btn"><MoreHorizontal /></button></td></tr>)}</tbody></table></div> : <EmptyState icon={Users} title="Nenhum usuário encontrado" text="Os membros aprovados da equipe aparecerão aqui." />}</section>
  </>;
}

function ProfileModal({ user, onClose, onLogout }: { user: AuthUser; onClose: () => void; onLogout: () => void }) {
  return <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className="modal profile-modal"><header className="modal-head"><div><h2>Meu perfil</h2><p>Dados pessoais e preferências da conta.</p></div><button className="icon-btn" onClick={onClose}><X /></button></header><div className="modal-body"><div className="profile-identity"><span className="avatar dark">{initials(user.name)}</span><div><strong>{user.name}</strong><span>{user.email}</span></div></div><dl className="profile-details"><div><dt>Perfil de acesso</dt><dd>{user.role === 'ADMIN' ? 'Administrador' : user.role === 'ANALYST' ? 'Analista' : 'Consulta'}</dd></div><div><dt>Fuso horário</dt><dd>America/Sao_Paulo</dd></div><div><dt>Notificações</dt><dd>Preferências configuráveis após integração da API.</dd></div></dl></div><footer className="form-footer"><button className="secondary" onClick={onLogout}>Encerrar sessão</button><button className="primary" onClick={onClose}>Fechar</button></footer></section></div>;
}

export function App({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const [page, setPage] = useState<Page>('Visão geral'); const [allRecords, setAllRecords] = useState(initialRecords); const [selected, setSelected] = useState<RecordItem | null>(null); const [status, setStatus] = useState<Status | null>(null); const [input, setInput] = useState(''); const [query, setQuery] = useState(''); const [creating, setCreating] = useState(false); const [editingRecordId, setEditingRecordId] = useState<string>(); const [success, setSuccess] = useState(''); const [loadError, setLoadError] = useState(''); const [notificationsOpen, setNotificationsOpen] = useState(false); const [profileOpen, setProfileOpen] = useState(false); const [profileModal, setProfileModal] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [recordsLoading, setRecordsLoading] = useState(true); const [recordsLoadError, setRecordsLoadError] = useState(false); const [recordsReloadKey, setRecordsReloadKey] = useState(0);
  const [temporalRefreshKey, setTemporalRefreshKey] = useState(0); const [requestedAttention, setRequestedAttention] = useState<RecordFilters['attention']>();
  const notificationAnchorRef = useRef<HTMLDivElement>(null); const notificationTriggerRef = useRef<HTMLButtonElement>(null); const profileAnchorRef = useRef<HTMLDivElement>(null); const profileTriggerRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null); const sidebarTriggerRef = useRef<HTMLButtonElement>(null); const recordFormOpenerRef = useRef<HTMLElement | null>(null);
  useEffect(() => { const timer = setTimeout(() => setQuery(input), 300); return () => clearTimeout(timer); }, [input]);
  useEffect(() => { if (!success) return; const timer = setTimeout(() => setSuccess(''), 3500); return () => clearTimeout(timer); }, [success]);
  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!notificationAnchorRef.current?.contains(target)) setNotificationsOpen(false);
      if (!profileAnchorRef.current?.contains(target)) setProfileOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (profileOpen) {
        setProfileOpen(false);
        requestAnimationFrame(() => profileTriggerRef.current?.focus());
      } else if (notificationsOpen) {
        setNotificationsOpen(false);
        requestAnimationFrame(() => notificationTriggerRef.current?.focus());
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => { document.removeEventListener('mousedown', handlePointerDown); window.removeEventListener('keydown', handleKeyDown); };
  }, [notificationsOpen, profileOpen]);
  useEffect(() => {
    if (!sidebarOpen) return;
    const sidebar = sidebarRef.current;
    const focusable = () => Array.from(sidebar?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []).filter(button => button.getClientRects().length > 0);
    requestAnimationFrame(() => focusable()[0]?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSidebarOpen(false);
        requestAnimationFrame(() => sidebarTriggerRef.current?.focus());
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [sidebarOpen]);
  useEffect(() => {
    if (page !== 'Dashboards') return;
    const controller = new AbortController(); setRecordsLoading(true); setRecordsLoadError(false);
    apiRequest<{ items: ApiRecord[] }>('/sac-records?page=1&pageSize=100&sort=updatedAt&order=desc', { signal: controller.signal }).then(result => setAllRecords(result.items.map(mapApiRecord))).catch(error => { if ((error as Error).name !== 'AbortError') setRecordsLoadError(true); }).finally(() => { if (!controller.signal.aborted) setRecordsLoading(false); });
    return () => controller.abort();
  }, [recordsReloadKey, page]);
  useEffect(() => {
    const refreshTime = () => setTemporalRefreshKey(value => value + 1);
    const visible = () => { if (document.visibilityState === 'visible') refreshTime(); };
    window.addEventListener('focus', refreshTime); document.addEventListener('visibilitychange', visible);
    const interval = window.setInterval(refreshTime, 300_000);
    return () => { window.removeEventListener('focus', refreshTime); document.removeEventListener('visibilitychange', visible); window.clearInterval(interval); };
  }, []);
  const rememberFormOpener = () => { recordFormOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; };
  const openCreateRecord = () => { rememberFormOpener(); setSelected(null); setEditingRecordId(undefined); setCreating(true); };
  const openEditRecord = (record: RecordItem) => { if (!record.id) return; rememberFormOpener(); setSelected(null); setCreating(false); setEditingRecordId(record.id); };
  const closeRecordForm = () => { setCreating(false); setEditingRecordId(undefined); requestAnimationFrame(() => recordFormOpenerRef.current?.focus()); };
  const saveRecord = (record: DetailedRecord, created: boolean) => {
    const mapped = mapApiRecord(record);
    setAllRecords(current => created ? [mapped, ...current.filter(item => item.id !== mapped.id)] : current.map(item => item.id === mapped.id ? mapped : item));
    setCreating(false); setEditingRecordId(undefined); setPage('Registros'); setRecordsReloadKey(value => value + 1); setSuccess(`${mapped.ticket} ${created ? 'criado' : 'atualizado'} com sucesso.`);
  };
  const refreshOperationalRecord = (record: OperationalRecord, message: string) => {
    const mapped = mapApiRecord(record);
    setAllRecords(current => current.map(item => item.id === mapped.id ? mapped : item));
    setSelected(mapped); setRecordsReloadKey(value => value + 1); setSuccess(message);
  };
  const roleLabel = user.role === 'ADMIN' ? 'Administrador' : user.role === 'ANALYST' ? 'Analista' : 'Consulta';
  const visibleNav = nav.filter(item => user.role === 'ADMIN' || (item.label !== 'Cadastros' && item.label !== 'Equipe'));
  const clearQuery = () => { setInput(''); setQuery(''); };
  const viewAttention = (filter: RecordFilters['attention']) => { setRequestedAttention(filter); setPage('Registros'); };
  const openNotificationRecord = async (recordId: string) => { const record = await apiRequest<OperationalRecord>(`/sac-records/${recordId}`); setPage('Registros'); setSelected(mapApiRecord(record)); };
  return <div className={`shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}><aside id="primary-sidebar" ref={sidebarRef} className={sidebarOpen ? 'sidebar-open' : ''} aria-label="Navegação principal"><div className="brand"><div className="brand-copy"><strong>SAC <em>Análises</em></strong><span>Do pedido à solução</span></div><button type="button" className="sidebar-collapse" aria-label={sidebarCollapsed ? 'Expandir menu lateral' : 'Recolher menu lateral'} aria-controls="primary-sidebar" aria-pressed={sidebarCollapsed} onClick={() => setSidebarCollapsed(value => !value)}>{sidebarCollapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}</button><button type="button" className="sidebar-close" aria-label="Fechar menu principal" onClick={() => { setSidebarOpen(false); requestAnimationFrame(() => sidebarTriggerRef.current?.focus()); }}><X aria-hidden="true" /></button></div><nav>{visibleNav.map(({ label, icon: Icon }) => <button className={page === label ? 'active' : ''} onClick={() => { setPage(label); setSidebarOpen(false); }} data-tooltip={label} aria-current={page === label ? 'page' : undefined} key={label}><Icon aria-hidden="true" />{label}</button>)}</nav><div className="sidebar-user"><span className="avatar dark">{initials(user.name)}</span><div><strong>{user.name}</strong><small>{roleLabel}</small></div></div></aside>{sidebarOpen && <button type="button" className="sidebar-backdrop" aria-label="Fechar menu principal" onClick={() => { setSidebarOpen(false); requestAnimationFrame(() => sidebarTriggerRef.current?.focus()); }} />}
    <main><header className="topbar" aria-label="Cabeçalho principal"><button ref={sidebarTriggerRef} type="button" className="sidebar-trigger" aria-label="Abrir menu principal" aria-controls="primary-sidebar" aria-expanded={sidebarOpen} onClick={() => { setSidebarOpen(true); setNotificationsOpen(false); setProfileOpen(false); }}><Menu aria-hidden="true" /></button><strong className="topbar-brand">SAC <em>Análises</em></strong><SearchInput className="global-search" value={input} onChange={setInput} onClear={clearQuery} placeholder="Buscar por ticket, pedido, cliente ou motivo..." label="Busca global" /><div className="topbar-actions">{user.role !== 'VIEWER' && <button className="primary topbar-new-record" onClick={openCreateRecord} aria-label="Novo registro"><Plus aria-hidden="true" /><span>Novo registro</span></button>}<NotificationCenter open={notificationsOpen} onOpenChange={value => { setNotificationsOpen(value); if (value) setProfileOpen(false); }} triggerRef={notificationTriggerRef} anchorRef={notificationAnchorRef} refreshKey={recordsReloadKey} onOpenRecord={openNotificationRecord} onMessage={setLoadError} /><div className="popover-anchor profile-anchor" ref={profileAnchorRef}><button ref={profileTriggerRef} className="user-trigger" aria-label={`Abrir menu do perfil de ${user.name}`} aria-haspopup="menu" aria-controls="profile-menu" aria-expanded={profileOpen} onClick={() => { setProfileOpen(v => !v); setNotificationsOpen(false); }}><span className="avatar dark">{initials(user.name)}</span><span className="user"><strong>{user.name}</strong><small>{roleLabel}</small></span><ChevronDown className="user-chevron" aria-hidden="true" /></button>{profileOpen && <section id="profile-menu" className="profile-menu" role="menu"><button role="menuitem" onClick={() => { setProfileModal(true); setProfileOpen(false); }}><CircleUserRound aria-hidden="true" />Meu perfil</button><button role="menuitem" onClick={() => { setProfileModal(true); setProfileOpen(false); }}><Settings2 aria-hidden="true" />Preferências</button><button role="menuitem" onClick={() => { setProfileModal(true); setProfileOpen(false); }}><KeyRound aria-hidden="true" />Alterar senha</button><div className="profile-menu-divider" role="separator" /><button role="menuitem" className="logout" onClick={onLogout}><LogOut aria-hidden="true" />Sair</button></section>}</div></div></header>
      <div className="content">{loadError && <div className="inline-error" role="alert">{loadError}<button onClick={() => setLoadError('')}>Fechar</button></div>}{page === 'Visão geral' && <Overview refresh={`${recordsReloadKey}-${temporalRefreshKey}`} query={query} status={status} setStatus={setStatus} onSelect={setSelected} selectedTicket={selected?.ticket} onClearQuery={clearQuery} onViewAttention={viewAttention} />}{page === 'Registros' && <RecordsPage refresh={`${recordsReloadKey}-${temporalRefreshKey}`} requestedAttention={requestedAttention} query={query} onSelect={setSelected} onEdit={openEditRecord} selectedTicket={selected?.ticket} onClearQuery={clearQuery} canCreate={user.role !== 'VIEWER'} onCreate={openCreateRecord} />}{page === 'Dashboards' && <DashboardsPage records={allRecords} />}{page === 'Equipe' && <TeamPage />}{page === 'Cadastros' && <CatalogPage onSuccess={setSuccess} />}</div>
    </main>{selected?.id && <CaseOperationsModal recordId={selected.id} user={user} onClose={() => setSelected(null)} onChanged={refreshOperationalRecord} />}{(creating || editingRecordId) && <SacRecordForm recordId={editingRecordId} onClose={closeRecordForm} onSaved={saveRecord} onOpenCatalogs={() => { setCreating(false); setEditingRecordId(undefined); setPage('Cadastros'); }} />}{profileModal && <ProfileModal user={user} onClose={() => setProfileModal(false)} onLogout={onLogout} />}{success && <div className="toast"><CheckCircle2 />{success}</div>}</div>;
}
