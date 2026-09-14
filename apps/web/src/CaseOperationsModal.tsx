import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, CalendarDays, CheckCircle2, FileText, LoaderCircle, MessageSquare, Paperclip, UserCheck, X } from 'lucide-react';
import { apiRequest, type AuthUser } from './api';
import { availableCaseActions, requiresDueDateReason, requiresPriorityReason, type CaseAction, type CaseStatus } from './case-workflow';
import type { DetailedRecord } from './SacRecordForm';

type Option = { id: string; name: string };
type Activity = { id: string; eventType: string; summary: string; createdAt: string; actor: Option; before?: unknown; after?: unknown };
type Comment = { id: string; body: string; createdAt: string; author: Option };
export type OperationalRecord = DetailedRecord & {
  solutionSummary: string | null; cancellationReason: string | null; completedAt: string | null; reopenedReason: string | null;
  comments: Comment[]; activities: Activity[];
};
type HistoryPage = { items: Activity[]; total: number; page: number; pageSize: number };
type Tab = 'Detalhes' | 'Itens' | 'Evidências' | 'Histórico';
type Operation = CaseAction | 'take' | 'assign' | 'priority' | 'due';

const statusLabels: Record<CaseStatus, string> = { PENDING: 'Pendente', IN_PROGRESS: 'Em andamento', COMPLETED: 'Concluído', CANCELLED: 'Cancelado' };
const priorityLabels = { LOW: 'Baixa', MEDIUM: 'Média', HIGH: 'Alta', CRITICAL: 'Crítica' } as const;
const operationLabels: Record<Operation, string> = {
  start: 'Iniciar atendimento', 'take-and-start': 'Assumir e iniciar', complete: 'Concluir caso', cancel: 'Cancelar caso',
  reopen: 'Reabrir caso', reactivate: 'Reativar caso', take: 'Assumir caso', assign: 'Alterar responsável', priority: 'Alterar prioridade', due: 'Alterar prazo',
};
const actionMessages: Record<Operation, string> = {
  start: 'Atendimento iniciado.', 'take-and-start': 'Caso assumido e atendimento iniciado.', complete: 'Caso concluído.', cancel: 'Caso cancelado.',
  reopen: 'Caso reaberto.', reactivate: 'Caso reativado.', take: 'Caso assumido.', assign: 'Responsável atualizado.', priority: 'Prioridade atualizada.', due: 'Prazo atualizado.',
};

function dateInput(value: string) {
  const date = new Date(value); const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function initials(name: string) { return name.split(' ').map(value => value[0]).slice(0, 2).join('').toUpperCase(); }
function formatDate(value: string) { return new Date(value).toLocaleString('pt-BR'); }

export function CaseOperationsModal({ recordId, user, onClose, onChanged }: { recordId: string; user: AuthUser; onClose: () => void; onChanged: (record: OperationalRecord, message: string) => void }) {
  const [record, setRecord] = useState<OperationalRecord | null>(null); const [assignees, setAssignees] = useState<Option[]>([]);
  const [tab, setTab] = useState<Tab>('Detalhes'); const [operation, setOperation] = useState<Operation | null>(null);
  const [history, setHistory] = useState<HistoryPage | null>(null); const [historyPage, setHistoryPage] = useState(1);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  const [comment, setComment] = useState(''); const [assigneeId, setAssigneeId] = useState(''); const [priority, setPriority] = useState<OperationalRecord['priority']>('MEDIUM');
  const [dueAt, setDueAt] = useState(''); const [reason, setReason] = useState(''); const [solution, setSolution] = useState('');
  const [cause, setCause] = useState(''); const [area, setArea] = useState(''); const [corrective, setCorrective] = useState(''); const [confirmed, setConfirmed] = useState(false);
  const modalRef = useRef<HTMLElement>(null);

  const load = async () => {
    setLoading(true); setError('');
    try {
      const detail = await apiRequest<OperationalRecord>(`/sac-records/${recordId}`); setRecord(detail);
      setAssigneeId(detail.assignee?.id ?? ''); setPriority(detail.priority); setDueAt(dateInput(detail.dueAt));
      setSolution(detail.solutionSummary ?? ''); setCause(detail.identifiedCause ?? ''); setArea(detail.responsibleArea ?? ''); setCorrective(detail.correctiveAction ?? '');
      if (user.role !== 'VIEWER') setAssignees(await apiRequest<Option[]>('/users/assignable'));
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Não foi possível carregar o caso.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [recordId]);
  useEffect(() => {
    if (tab !== 'Histórico') return;
    apiRequest<HistoryPage>(`/sac-records/${recordId}/history?page=${historyPage}&pageSize=20`).then(next => setHistory(current => historyPage === 1 ? next : { ...next, items: [...(current?.items ?? []), ...next.items] })).catch(caught => setError(caught instanceof Error ? caught.message : 'Não foi possível carregar o histórico.'));
  }, [recordId, tab, historyPage, record?.updatedAt]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { if (operation) setOperation(null); else if (!comment) onClose(); return; }
      if (event.key !== 'Tab' || !modalRef.current) return;
      const focusable = Array.from(modalRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')).filter(element => element.offsetParent !== null);
      if (!focusable.length) return; const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [comment, onClose, operation]);

  const actions = useMemo(() => record ? availableCaseActions(record.status, user.role, Boolean(record.assignee)) : [], [record, user.role]);
  const begin = (next: Operation) => { setReason(''); setConfirmed(false); setOperation(next); setError(''); };
  const applySaved = (saved: OperationalRecord, message: string) => { setRecord(saved); setHistoryPage(1); setOperation(null); setReason(''); setConfirmed(false); onChanged(saved, message); };
  const execute = async (event: FormEvent) => {
    event.preventDefault(); if (!record || !operation || saving) return; setSaving(true); setError('');
    try {
      let path = `/sac-records/${record.id}/status`; let method = 'POST'; let payload: Record<string, unknown> = { updatedAt: record.updatedAt };
      if (operation === 'assign') { path = `/sac-records/${record.id}/assignee`; method = 'PATCH'; payload = { ...payload, assigneeId: assigneeId || null, justification: reason || undefined }; }
      else if (operation === 'take') { path = `/sac-records/${record.id}/take`; method = 'POST'; }
      else if (operation === 'priority') { path = `/sac-records/${record.id}/priority`; method = 'PATCH'; payload = { ...payload, priority, justification: reason || undefined }; }
      else if (operation === 'due') { path = `/sac-records/${record.id}/due-date`; method = 'PATCH'; payload = { ...payload, dueAt: new Date(`${dueAt}T23:59:59`).toISOString(), justification: reason || undefined }; }
      else if (operation === 'start' || operation === 'take-and-start') payload = { ...payload, status: 'IN_PROGRESS', assumeIfUnassigned: operation === 'take-and-start' };
      else if (operation === 'complete') payload = { ...payload, status: 'COMPLETED', solutionSummary: solution, identifiedCause: cause, responsibleArea: area, correctiveAction: corrective };
      else if (operation === 'cancel') payload = { ...payload, status: 'CANCELLED', reason };
      else if (operation === 'reopen') payload = { ...payload, status: 'IN_PROGRESS', reason };
      else if (operation === 'reactivate') payload = { ...payload, status: 'PENDING', reason };
      const saved = await apiRequest<OperationalRecord>(path, { method, body: JSON.stringify(payload) }); applySaved(saved, actionMessages[operation]);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Não foi possível concluir a operação.'); }
    finally { setSaving(false); }
  };
  const sendComment = async (event: FormEvent) => {
    event.preventDefault(); if (!record || !comment.trim() || saving) return; setSaving(true); setError('');
    try {
      const result = await apiRequest<{ record: OperationalRecord }>(`/sac-records/${record.id}/comments`, { method: 'POST', body: JSON.stringify({ body: comment, updatedAt: record.updatedAt }) });
      setComment(''); applySaved(result.record, 'Comentário adicionado.'); setTab('Histórico');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Não foi possível adicionar o comentário.'); }
    finally { setSaving(false); }
  };

  if (loading) return <div className="overlay"><section className="modal operational-modal"><div className="operational-loading" role="status"><LoaderCircle />Carregando caso...</div></section></div>;
  if (!record) return <div className="overlay"><section className="modal operational-modal"><div className="list-error"><AlertTriangle /><div><strong>Não foi possível abrir o caso</strong><span>{error}</span></div><button className="secondary" onClick={() => void load()}>Tentar novamente</button><button className="secondary" onClick={onClose}>Fechar</button></div></section></div>;
  const needsReason = operation === 'cancel' || operation === 'reopen' || operation === 'reactivate' || (operation === 'priority' && requiresPriorityReason(record.priority, priority)) || (operation === 'due' && requiresDueDateReason(record.dueAt, dueAt));
  const tabs: Tab[] = ['Detalhes', 'Itens', 'Evidências', 'Histórico'];
  const timeline = [
    ...record.comments.map(item => ({ id: item.id, createdAt: item.createdAt, comment: item })),
    ...(history?.items.filter(item => item.eventType !== 'COMMENT_ADDED').map(item => ({ id: item.id, createdAt: item.createdAt, activity: item })) ?? []),
  ].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  return <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget && !comment) onClose(); }}><section ref={modalRef} className="modal operational-modal" role="dialog" aria-modal="true" aria-labelledby="case-title">
    <header className="modal-head operational-head"><div><div className="modal-title-row"><h2 id="case-title">{record.ticket}</h2><span className={`badge badge-${record.status.toLowerCase().replace('_', '-')}`}>{statusLabels[record.status]}</span><span className={`priority priority-${record.priority.toLowerCase()}`}>{priorityLabels[record.priority]}</span></div><p>{record.customer.name}<span>•</span>Pedido {record.orderNumber}<span>•</span>{record.reason.name}</p></div><button type="button" className="icon-btn" onClick={onClose} aria-label="Fechar caso"><X /></button></header>
    <div className="operational-toolbar"><span className="owner"><span className="avatar">{record.assignee ? initials(record.assignee.name) : '?'}</span>{record.assignee?.name ?? 'Sem responsável'}</span><span className={new Date(record.dueAt) < new Date() && record.status !== 'COMPLETED' ? 'overdue' : ''}><CalendarDays />{new Date(record.dueAt).toLocaleDateString('pt-BR')}</span>{user.role !== 'VIEWER' && (record.status === 'PENDING' || record.status === 'IN_PROGRESS') && <div>{!record.assignee && <button className="secondary" onClick={() => begin('take')}><UserCheck />Assumir</button>}<button className="secondary" onClick={() => begin('assign')}><UserCheck />Responsável</button><button className="secondary" onClick={() => begin('priority')}>Prioridade</button><button className="secondary" onClick={() => begin('due')}>Prazo</button></div>}</div>
    <nav className="tabs" aria-label="Conteúdo do caso">{tabs.map(value => <button type="button" key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{value}</button>)}</nav>
    <div className="modal-body operational-body">{error && <div className="inline-error" role="alert">{error}<button onClick={() => setError('')}>Fechar</button></div>}
      {tab === 'Detalhes' && <section className="case-details"><dl><div><dt>Canal</dt><dd>{record.channelCatalog?.name ?? 'Não informado'}</dd></div><div><dt>Abertura</dt><dd>{formatDate(record.openedAt)}</dd></div><div><dt>Última atualização</dt><dd>{formatDate(record.updatedAt)}</dd></div><div><dt>Protocolo externo</dt><dd>{record.externalTicket ?? 'Não informado'}</dd></div></dl><article><strong>Descrição</strong><p>{record.description}</p></article>{record.internalNote && <article><strong>Observação interna</strong><p>{record.internalNote}</p></article>}<div className="case-conclusion"><article><strong>Resumo da solução</strong><p>{record.solutionSummary || 'Ainda não informado.'}</p></article><article><strong>Causa identificada</strong><p>{record.identifiedCause || 'Ainda não informada.'}</p></article><article><strong>Área responsável</strong><p>{record.responsibleArea || 'Ainda não informada.'}</p></article><article><strong>Ação corretiva</strong><p>{record.correctiveAction || 'Ainda não informada.'}</p></article></div></section>}
      {tab === 'Itens' && <section className="modal-section"><div className="section-heading"><div><h3>Itens relacionados</h3><p>{record.items.length} item(ns) registrado(s)</p></div></div>{record.items.length ? <div className="compact-table"><table><thead><tr><th>Código</th><th>Descrição</th><th>Lote</th><th>Quantidade</th></tr></thead><tbody>{record.items.map(item => <tr key={item.id}><td>{item.code}</td><td>{item.description}</td><td>{item.batch ?? '—'}</td><td>{item.quantity}</td></tr>)}</tbody></table></div> : <div className="empty-state"><FileText /><strong>Nenhum item relacionado</strong></div>}</section>}
      {tab === 'Evidências' && <section className="modal-section"><div className="section-heading"><div><h3>Evidências anexadas</h3><p>Arquivos preservados no registro</p></div></div>{record.attachments.length ? <div className="attachment-list">{record.attachments.map(file => <article key={file.id}><span className="file-icon"><Paperclip /></span><div><strong>{file.originalName}</strong><small>{file.mimeType} · {Math.ceil(file.sizeBytes / 1024)} KB</small></div></article>)}</div> : <div className="empty-state"><Paperclip /><strong>Nenhuma evidência anexada</strong></div>}</section>}
      {tab === 'Histórico' && <section className="history-section"><form className="comment-form" onSubmit={sendComment}><label htmlFor="case-comment">Comentário interno</label><textarea id="case-comment" value={comment} maxLength={4000} disabled={user.role === 'VIEWER'} onChange={event => setComment(event.target.value)} placeholder={user.role === 'VIEWER' ? 'Perfil de consulta não pode comentar.' : 'Registre uma atualização objetiva...'} /><div><small>{comment.length}/4000</small>{user.role !== 'VIEWER' && <button className="primary" disabled={!comment.trim() || saving}><MessageSquare />Adicionar comentário</button>}</div></form><div className="timeline timeline-expanded"><h3>Linha do tempo</h3>{timeline.map(item => 'comment' in item ? <div key={item.id}><i className="dot magenta" /><time>{formatDate(item.createdAt)}</time><p><strong>Comentário de {item.comment.author.name}</strong><span>{item.comment.body}</span></p></div> : <div key={item.id}><i className="dot" /><time>{formatDate(item.createdAt)}</time><p><strong>{item.activity.summary}</strong><span>Por {item.activity.actor.name}</span></p></div>)}{!timeline.length && <div className="empty-state"><CheckCircle2 /><strong>Nenhum evento registrado</strong></div>}</div>{history && history.page * history.pageSize < history.total && <button className="secondary history-more" onClick={() => setHistoryPage(value => value + 1)}>Carregar mais</button>}</section>}
    </div>
    <footer className="operational-actions">{actions.map(action => <button type="button" key={action} className={action === 'cancel' ? 'sac-danger-action' : 'primary'} onClick={() => begin(action)}>{operationLabels[action]}</button>)}</footer>
    {operation && <form className="operation-panel" onSubmit={execute}><header><div><strong>{operationLabels[operation]}</strong><span>Confirme os dados desta ação operacional.</span></div><button type="button" className="icon-btn" onClick={() => setOperation(null)} aria-label="Fechar ação"><X /></button></header>{operation === 'assign' && <label>Responsável<select value={assigneeId} onChange={event => setAssigneeId(event.target.value)}><option value="">Sem responsável</option>{assignees.map(option => <option value={option.id} key={option.id}>{option.name}</option>)}</select></label>}{operation === 'priority' && <label>Nova prioridade<select value={priority} onChange={event => setPriority(event.target.value as OperationalRecord['priority'])}>{Object.entries(priorityLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>}{operation === 'due' && <label>Novo prazo<input type="date" value={dueAt} min={dateInput(record.openedAt)} onChange={event => setDueAt(event.target.value)} /></label>}{operation === 'complete' && <div className="operation-grid"><label>Resumo da solução *<textarea value={solution} maxLength={5000} required onChange={event => setSolution(event.target.value)} /></label><label>Causa identificada *<textarea value={cause} maxLength={2000} required onChange={event => setCause(event.target.value)} /></label><label>Área responsável *<input value={area} maxLength={160} required onChange={event => setArea(event.target.value)} /></label><label>Ação corretiva *<textarea value={corrective} maxLength={2000} required onChange={event => setCorrective(event.target.value)} /></label></div>}{needsReason && <label>Justificativa *<textarea value={reason} maxLength={2000} required onChange={event => setReason(event.target.value)} /></label>}<label className="operation-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Confirmo esta alteração e seu registro no histórico.</label><footer><button type="button" className="secondary" onClick={() => setOperation(null)}>Voltar</button><button className="primary" disabled={!confirmed || saving}>{saving ? 'Salvando...' : 'Confirmar'}</button></footer></form>}
  </section></div>;
}
