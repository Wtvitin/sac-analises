import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { AlertTriangle, Bell, CalendarClock, CheckCheck, Clock3, MessageSquare, RefreshCw, RotateCcw, UserCheck, X } from 'lucide-react';
import { apiRequest } from './api';
import { notificationCountLabel, notificationEmptyCopy } from './notification-center.utils';

type NotificationType = 'ASSIGNED' | 'ASSIGNEE_CHANGED' | 'COMMENT_ADDED' | 'STATUS_CHANGED' | 'PRIORITY_RAISED' | 'DUE_DATE_CHANGED' | 'NEAR_DUE' | 'DUE_TODAY' | 'OVERDUE' | 'STALE' | 'UNASSIGNED' | 'REOPENED' | 'CANCELLED' | 'COMPLETED';
type NotificationItem = { id: string; type: NotificationType; title: string; summary: string; createdAt: string; readAt: string | null; record: { id: string; ticket: string; archivedAt: string | null } | null };
type NotificationPage = { items: NotificationItem[]; total: number; page: number; pageSize: number };
type Filter = 'all' | 'unread';

const icons: Partial<Record<NotificationType, typeof Bell>> = { ASSIGNED: UserCheck, ASSIGNEE_CHANGED: UserCheck, COMMENT_ADDED: MessageSquare, DUE_DATE_CHANGED: CalendarClock, NEAR_DUE: CalendarClock, DUE_TODAY: CalendarClock, OVERDUE: AlertTriangle, STALE: Clock3, UNASSIGNED: UserCheck, REOPENED: RotateCcw };

function relativeDate(value: string, now = new Date()) {
  const date = new Date(value); const minutes = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 60_000));
  if (minutes < 1) return 'Agora'; if (minutes < 60) return `Há ${minutes} min`;
  const hours = Math.floor(minutes / 60); if (hours < 24) return `Há ${hours} ${hours === 1 ? 'hora' : 'horas'}`;
  const days = Math.floor(hours / 24); return days < 7 ? `Há ${days} ${days === 1 ? 'dia' : 'dias'}` : date.toLocaleDateString('pt-BR');
}

export function NotificationCenter({ open, onOpenChange, triggerRef, anchorRef, refreshKey, onOpenRecord, onMessage }: {
  open: boolean; onOpenChange: (open: boolean) => void; triggerRef: RefObject<HTMLButtonElement | null>; anchorRef: RefObject<HTMLDivElement | null>;
  refreshKey: unknown; onOpenRecord: (recordId: string) => Promise<void>; onMessage: (message: string) => void;
}) {
  const [unread, setUnread] = useState(0); const [filter, setFilter] = useState<Filter>('all'); const [items, setItems] = useState<NotificationItem[]>([]); const [total, setTotal] = useState(0); const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false); const [error, setError] = useState(''); const [announcement, setAnnouncement] = useState(''); const panelRef = useRef<HTMLElement>(null); const lastUnreadRef = useRef<number | undefined>(undefined);
  const fetchCount = useCallback(() => apiRequest<{ count: number }>('/notifications/unread-count').then(result => { const previous = lastUnreadRef.current; if (previous !== undefined && result.count > previous) { const added = result.count - previous; setAnnouncement(`${added} ${added === 1 ? 'nova notificação' : 'novas notificações'}.`); } lastUnreadRef.current = result.count; setUnread(result.count); }).catch(() => undefined), []);
  const load = useCallback(async (nextPage: number, replace = false) => {
    setLoading(true); setError('');
    try { const result = await apiRequest<NotificationPage>(`/notifications?filter=${filter}&page=${nextPage}&pageSize=20`); setItems(current => replace ? result.items : [...current, ...result.items]); setTotal(result.total); setPage(nextPage); }
    catch { setError('Não foi possível carregar as notificações.'); }
    finally { setLoading(false); }
  }, [filter]);
  useEffect(() => { void fetchCount(); const focus = () => void fetchCount(); const visible = () => { if (document.visibilityState === 'visible') void fetchCount(); }; window.addEventListener('focus', focus); document.addEventListener('visibilitychange', visible); const timer = window.setInterval(fetchCount, 60_000); return () => { window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', visible); window.clearInterval(timer); }; }, [fetchCount, refreshKey]);
  useEffect(() => { if (open) { setItems([]); setPage(1); void load(1, true); requestAnimationFrame(() => panelRef.current?.querySelector<HTMLButtonElement>('.notification-close')?.focus()); } }, [open, filter, load]);
  useEffect(() => {
    if (!open) return; const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onOpenChange(false); requestAnimationFrame(() => triggerRef.current?.focus()); return; }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>('button:not(:disabled)')).filter(element => element.offsetParent !== null); if (!focusable.length) return;
      const first = focusable[0]; const last = focusable.at(-1)!; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [open, onOpenChange, triggerRef]);
  const close = () => { onOpenChange(false); requestAnimationFrame(() => triggerRef.current?.focus()); };
  const markAll = async () => { try { const result = await apiRequest<{ updated: number }>('/notifications/read-all', { method: 'PATCH' }); const readAt = new Date().toISOString(); setItems(current => filter === 'unread' ? [] : current.map(item => ({ ...item, readAt: item.readAt ?? readAt }))); setTotal(value => filter === 'unread' ? Math.max(0, value - result.updated) : value); lastUnreadRef.current = 0; setUnread(0); setAnnouncement('Todas as notificações foram marcadas como lidas.'); } catch { setError('Não foi possível marcar as notificações como lidas.'); } };
  const activate = async (item: NotificationItem) => {
    try { if (!item.readAt) { const saved = await apiRequest<NotificationItem>(`/notifications/${item.id}/read`, { method: 'PATCH' }); setItems(current => current.map(value => value.id === item.id ? saved : value)); setUnread(value => { const next = Math.max(0, value - 1); lastUnreadRef.current = next; return next; }); } onOpenChange(false); if (item.record?.id && !item.record.archivedAt) await onOpenRecord(item.record.id); else onMessage('O caso relacionado não está mais disponível.'); }
    catch { onOpenChange(false); onMessage('Não foi possível abrir o caso relacionado.'); }
  };
  const emptyCopy = notificationEmptyCopy(filter);
  return <div className="popover-anchor notification-anchor" ref={anchorRef}><button ref={triggerRef} className="bell" aria-label={unread ? `Notificações, ${unread} não lidas` : 'Notificações'} aria-haspopup="dialog" aria-controls="notification-popover" aria-expanded={open} onClick={() => onOpenChange(!open)}><Bell aria-hidden="true" />{unread > 0 && <span className="notification-count" aria-hidden="true">{notificationCountLabel(unread)}</span>}</button><span className="sr-only" aria-live="polite">{announcement}</span>{open && <section ref={panelRef} id="notification-popover" className="notification-popover notification-center" role="dialog" aria-modal="true" aria-labelledby="notification-title"><header><div><strong id="notification-title">Notificações</strong><small>{unread} {unread === 1 ? 'não lida' : 'não lidas'}</small></div><button type="button" className="notification-close" aria-label="Fechar notificações" onClick={close}><X aria-hidden="true" /></button></header><div className="notification-controls"><div role="tablist" aria-label="Filtro de notificações"><button role="tab" aria-selected={filter === 'all'} className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>Todas</button><button role="tab" aria-selected={filter === 'unread'} className={filter === 'unread' ? 'active' : ''} onClick={() => setFilter('unread')}>Não lidas</button></div><button className="mark-all" disabled={!unread} onClick={() => void markAll()}><CheckCheck aria-hidden="true" />Marcar todas como lidas</button></div><div className="notification-scroll">{error && <div className="notification-error" role="alert"><AlertTriangle aria-hidden="true" /><span>{error}</span><button onClick={() => void load(1, true)}><RefreshCw aria-hidden="true" />Tentar novamente</button></div>}{!error && loading && !items.length && <div className="notification-loading" role="status">Carregando notificações...</div>}{!error && !loading && !items.length && <div className="notification-empty"><Bell aria-hidden="true" /><strong>{emptyCopy.title}</strong><span>{emptyCopy.summary}</span></div>}{items.length > 0 && <div className="notification-list">{items.map(item => { const Icon = icons[item.type] ?? Bell; const fullDate = new Date(item.createdAt).toLocaleString('pt-BR'); return <button type="button" key={item.id} className={item.readAt ? 'is-read' : 'is-unread'} onClick={() => void activate(item)}><span className="notification-icon"><Icon aria-hidden="true" /></span><span className="notification-copy"><span className="notification-title-row"><strong>{item.title}</strong>{!item.readAt && <em>Não lida</em>}</span><span>{item.summary}</span>{item.record && <small>{item.record.ticket}</small>}<time title={fullDate} aria-label={`${relativeDate(item.createdAt)}. ${fullDate}`}>{relativeDate(item.createdAt)}</time></span></button>; })}</div>}{items.length < total && <button className="notification-more" disabled={loading} onClick={() => void load(page + 1)}>{loading ? 'Carregando...' : 'Carregar mais'}</button>}</div></section>}</div>;
}
