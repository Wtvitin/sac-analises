import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, Building2, CalendarDays, CheckCircle2, Download, Eye, EyeOff, FileText, LoaderCircle, Lock, MessageSquare, Paperclip, Pencil, UserCheck, X } from 'lucide-react';
import { apiRequest, downloadFile, DEFAULT_USER_DEPARTMENTS, ApiRequestError, type AuthUser } from './api';
import { availableCaseActions, buildOperationRequest, requiresDueDateReason, requiresPriorityReason, type CaseAction, type CaseOperation, type CaseStatus } from './case-workflow';
import { can } from './permissions';
import { SAC_REFERENCE_LABELS } from './sac-form';
import type { DetailedRecord } from './SacRecordForm';
import { getOpenDuration, resolveClosedDate } from './record-listing';

type Option = { id: string; name: string };
type Activity = { id: string; eventType: string; summary: string; createdAt: string; actor: Option; before?: unknown; after?: unknown };
type Comment = { id: string; body: string; createdAt: string; author: Option };
export type OperationalRecord = DetailedRecord & {
  solutionSummary: string | null; cancellationReason: string | null; completedAt: string | null; reopenedReason: string | null;
  comments: Comment[]; activities: Activity[];
};
type HistoryPage = { items: Activity[]; total: number; page: number; pageSize: number };
type Tab = 'Detalhes' | 'Itens' | 'Evidências' | 'Histórico';
type Operation = CaseOperation;

const statusLabels: Record<CaseStatus, string> = { PENDING: 'Pendente', IN_PROGRESS: 'Em andamento', COMPLETED: 'Concluído', CANCELLED: 'Cancelado' };
const priorityLabels = { LOW: 'Baixa', MEDIUM: 'Média', HIGH: 'Alta', CRITICAL: 'Crítica' } as const;
const operationLabels: Record<Operation, string> = {
  start: 'Iniciar atendimento', 'take-and-start': 'Assumir e iniciar', complete: 'Concluir caso', cancel: 'Cancelar caso',
  reopen: 'Reabrir caso', reactivate: 'Reativar caso', take: 'Assumir caso', assign: 'Alterar responsável', priority: 'Alterar prioridade', due: 'Alterar prazo',
  treatment: 'Registrar tratativa / resposta', department: 'Alterar / definir setor',
};
const actionMessages: Record<Operation, string> = {
  start: 'Atendimento iniciado.', 'take-and-start': 'Caso assumido e atendimento iniciado.', complete: 'Caso concluído.', cancel: 'Caso cancelado.',
  reopen: 'Caso reaberto.', reactivate: 'Caso reativado.', take: 'Caso assumido.', assign: 'Responsável atualizado.', priority: 'Prioridade atualizada.', due: 'Prazo atualizado.',
  treatment: 'Resposta e tratativa registradas com sucesso.', department: 'Setor do caso atualizado com sucesso.',
};
const attentionLabels = { OVERDUE: 'Atrasado', DUE_TODAY: 'Vence hoje', NEAR_DUE: 'Prazo próximo', HIGH_PRIORITY: 'Alta prioridade', UNASSIGNED: 'Sem responsável', STALE: 'Sem atualização', NO_DUE: 'Sem prazo' } as const;
const dueLabels = { WITHIN_DUE: 'Dentro do prazo', NEAR_DUE: 'Próximo do prazo', DUE_TODAY: 'Vence hoje', OVERDUE: 'Atrasado', NO_DUE: 'Sem prazo', CLOSED: 'Prazo encerrado' } as const;
function operationalDueLabel(record: OperationalRecord) { return record.operational.isOverdue ? `Atrasado há ${record.operational.overdueDays} ${record.operational.overdueDays === 1 ? 'dia' : 'dias'}` : dueLabels[record.operational.dueState]; }
function operationalActivityLabel(record: OperationalRecord) { return record.operational.isStale ? `Sem atualização há ${record.operational.staleDays} dias` : record.operational.staleDays === 0 ? 'Atualizado hoje' : `Atualizado há ${record.operational.staleDays} dia(s)`; }

function dateInput(value: string) {
  const date = new Date(value); const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function initials(name: string) { return name.split(' ').map(value => value[0]).slice(0, 2).join('').toUpperCase(); }
function formatDate(value: string) { return new Date(value).toLocaleString('pt-BR'); }

export function CaseOperationsModal({ recordId, user, onClose, onChanged }: { recordId: string; user: AuthUser; onClose: () => void; onChanged: (record: OperationalRecord, message: string) => void }) {
  const [record, setRecord] = useState<OperationalRecord | null>(null); const [assignees, setAssignees] = useState<Option[]>([]);
  const [departments, setDepartments] = useState<string[]>([...DEFAULT_USER_DEPARTMENTS]);
  const [targetDepartment, setTargetDepartment] = useState('');
  const [tab, setTab] = useState<Tab>('Detalhes'); const [operation, setOperation] = useState<Operation | null>(null);
  const [history, setHistory] = useState<HistoryPage | null>(null); const [historyPage, setHistoryPage] = useState(1);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  const [comment, setComment] = useState(''); const [assigneeId, setAssigneeId] = useState(''); const [priority, setPriority] = useState<OperationalRecord['priority']>('MEDIUM');
  const [dueAt, setDueAt] = useState(''); const [reason, setReason] = useState(''); const [solution, setSolution] = useState('');
  const [cause, setCause] = useState(''); const [area, setArea] = useState(''); const [corrective, setCorrective] = useState(''); const [confirmed, setConfirmed] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [revealingCustomerDoc, setRevealingCustomerDoc] = useState(false);
  const modalRef = useRef<HTMLElement>(null);
  const canWriteCases = can(user.role, 'cases:write');

  const handleClose = () => {
    setRecord(null);
    onClose();
  };

  const hideCustomerDoc = () => {
    setRecord(current => current ? {
      ...current,
      customer: {
        ...current.customer,
        document: '***',
        isDocumentMasked: true,
      }
    } : null);
  };

  const revealCustomerDoc = async () => {
    if (!record || user.role !== 'ADMIN') return;
    if (!window.confirm('Confirma a revelação deste dado sensível? Esta ação gerará um registro de auditoria.')) {
      return;
    }
    setRevealingCustomerDoc(true);
    try {
      const res = await apiRequest<{ customerDocument?: string; revealedValue?: string }>(`/sac-records/${record.id}/reveal-sensitive`, {
        method: 'POST',
        body: JSON.stringify({ field: 'customerDocument' }),
      });
      const val = res?.customerDocument || res?.revealedValue;
      if (val) {
        setRecord(current => current ? {
          ...current,
          customer: {
            ...current.customer,
            document: val,
            isDocumentMasked: false,
          }
        } : null);
      }
    } catch (err: any) {
      setError(err.message || 'Não foi possível revelar o documento do cliente.');
    } finally {
      setRevealingCustomerDoc(false);
    }
  };

  const handleDownload = async (attachmentId: string, filename: string) => {
    try {
      setDownloadingId(attachmentId);
      setError('');
      await downloadFile(`/attachments/${attachmentId}/download`, filename);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Falha ao baixar arquivo.');
    } finally {
      setDownloadingId(null);
    }
  };

  const load = async () => {
    setLoading(true); setError('');
    try {
      const detail = await apiRequest<OperationalRecord>(`/sac-records/${recordId}`); setRecord(detail);
      setAssigneeId(detail.assignee?.id ?? ''); setPriority(detail.priority); setDueAt(dateInput(detail.dueAt));
      setSolution(detail.solutionSummary ?? ''); setCause(detail.identifiedCause ?? ''); setArea(detail.responsibleArea ?? ''); setCorrective(detail.correctiveAction ?? '');
      setTargetDepartment(detail.department ?? '');
      if (canWriteCases) {
        const deptQuery = detail.department ? `?department=${encodeURIComponent(detail.department)}` : '';
        setAssignees(await apiRequest<Option[]>(`/users/assignable${deptQuery}`));
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Não foi possível carregar o caso.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [recordId]);
  useEffect(() => {
    apiRequest<string[]>('/users/departments')
      .then(result => {
        if (Array.isArray(result) && result.length > 0) {
          setDepartments(Array.from(new Set([...DEFAULT_USER_DEPARTMENTS, ...result])));
        }
      })
      .catch(() => {});
  }, []);
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
  const beginTreatment = () => {
    if (!record) return;
    setSolution(record.solutionSummary ?? '');
    setCause(record.identifiedCause ?? '');
    setArea(record.responsibleArea ?? '');
    setCorrective(record.correctiveAction ?? '');
    begin('treatment');
  };
  const applySaved = (saved: OperationalRecord, message: string) => { setRecord(saved); setTargetDepartment(saved.department ?? ''); setHistoryPage(1); setOperation(null); setReason(''); setConfirmed(false); onChanged(saved, message); };
  const execute = async (event: FormEvent) => {
    event.preventDefault();
    if (!record || !operation || saving) return;
    setSaving(true);
    setError('');

    try {
      const { path, method, payload } = buildOperationRequest(record.id, {
        operation,
        updatedAt: record.updatedAt,
        assigneeId,
        priority,
        dueAt,
        reason,
        solution,
        cause,
        area,
        corrective,
        targetDepartment,
        recordDepartment: record.department,
        recordIdentifiedCause: record.identifiedCause,
        recordResponsibleArea: record.responsibleArea,
        recordCorrectiveAction: record.correctiveAction,
      });

      const saved = await apiRequest<OperationalRecord>(path, { method, body: JSON.stringify(payload) });
      const message = operation === 'department'
        ? (record.department ? 'Setor do caso alterado com sucesso.' : 'Setor do caso definido com sucesso.')
        : actionMessages[operation];
      applySaved(saved, message);
    } catch (caught: any) {
      const isStale = (caught instanceof ApiRequestError && (caught.status === 409 || caught.code === 'STALE_SAC_RECORD'))
        || (caught instanceof Error && (
          caught.message.toLowerCase().includes('atualizado por outro') ||
          caught.message.toLowerCase().includes('recarregue as informações')
        ));

      if (isStale) {
        try {
          await load();
        } catch {}
        setConfirmed(false);
        setError('Este caso foi atualizado por outro usuário. Os dados mais recentes foram recarregados; revise e confirme novamente para continuar.');
      } else {
        setError(caught instanceof Error ? caught.message : 'Não foi possível concluir a operação.');
      }
    } finally {
      setSaving(false);
    }
  };

  const sendComment = async (event: FormEvent) => {
    event.preventDefault();
    if (!record || !comment.trim() || saving) return;
    setSaving(true);
    setError('');
    try {
      const result = await apiRequest<{ record: OperationalRecord }>(`/sac-records/${record.id}/comments`, { method: 'POST', body: JSON.stringify({ body: comment, updatedAt: record.updatedAt }) });
      setComment('');
      applySaved(result.record, 'Comentário adicionado.');
      setTab('Histórico');
    } catch (caught: any) {
      const isStale = (caught instanceof ApiRequestError && (caught.status === 409 || caught.code === 'STALE_SAC_RECORD'))
        || (caught instanceof Error && (
          caught.message.toLowerCase().includes('atualizado por outro') ||
          caught.message.toLowerCase().includes('recarregue as informações')
        ));
      if (isStale) {
        try {
          await load();
        } catch {}
        setError('Este caso foi atualizado por outro usuário. Os dados foram recarregados; por favor, envie o comentário novamente.');
      } else {
        setError(caught instanceof Error ? caught.message : 'Não foi possível adicionar o comentário.');
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="overlay"><section className="modal operational-modal"><div className="operational-loading" role="status"><LoaderCircle />Carregando caso...</div></section></div>;
  if (!record) return <div className="overlay"><section className="modal operational-modal"><div className="list-error"><AlertTriangle /><div><strong>Não foi possível abrir o caso</strong><span>{error}</span></div><button className="secondary" onClick={() => void load()}>Tentar novamente</button><button className="secondary" onClick={handleClose}>Fechar</button></div></section></div>;
  const needsReason = operation === 'cancel' || operation === 'reopen' || operation === 'reactivate' || (operation === 'priority' && requiresPriorityReason(record.priority, priority)) || (operation === 'due' && requiresDueDateReason(record.dueAt, dueAt));
  const tabs: Tab[] = ['Detalhes', 'Itens', 'Evidências', 'Histórico'];
  const timeline = [
    ...record.comments.map(item => ({ id: item.id, createdAt: item.createdAt, comment: item })),
    ...(history?.items.filter(item => item.eventType !== 'COMMENT_ADDED').map(item => ({ id: item.id, createdAt: item.createdAt, activity: item })) ?? []),
  ].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  return <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget && !comment) handleClose(); }}><section ref={modalRef} className="modal operational-modal" role="dialog" aria-modal="true" aria-labelledby="case-title">
    <header className="modal-head operational-head"><div><div className="modal-title-row"><h2 id="case-title">{record.ticket}</h2><span className={`badge badge-${record.status.toLowerCase().replace('_', '-')}`}>{statusLabels[record.status]}</span><span className={`priority priority-${record.priority.toLowerCase()}`}>{priorityLabels[record.priority]}</span></div><p>{record.customer.name}<span>•</span>{record.orderNumber ? `Pedido ${record.orderNumber}` : (record.references && record.references.length > 0) ? `${SAC_REFERENCE_LABELS[record.references[0].type] || record.references[0].type}: ${record.references[0].value}` : 'Sem pedido'}<span>•</span>{record.reason.name}</p></div><button type="button" className="icon-btn" onClick={handleClose} aria-label="Fechar caso"><X /></button></header>
    <div className="operational-summary">
      <div className="operational-toolbar">
        <span className="owner"><span className="avatar">{record.assignee ? initials(record.assignee.name) : '?'}</span>{record.assignee?.name ?? 'Sem responsável'}</span>
        <span className={record.operational.isOverdue ? 'overdue' : ''} title={`Data limite: ${new Date(record.dueAt).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`}><CalendarDays />{operationalDueLabel(record)}</span>
        <span className={record.operational.isStale ? 'overdue' : ''} title={`Última atividade: ${formatDate(record.operational.lastOperationalActivityAt)}`}>{operationalActivityLabel(record)}</span>
        <span className="toolbar-department" title="Setor do caso" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}><Building2 style={{ width: 14, height: 14, color: record.department ? '#0a67c3' : '#94a3b8' }} /><strong>Setor:</strong> {record.department || 'Sem setor definido'}</span>
        <div>
          {user.role !== 'VIEWER' && (record.status === 'PENDING' || record.status === 'IN_PROGRESS') && (
            <>
              {!record.assignee && <button type="button" className="secondary" onClick={() => begin('take')}><UserCheck />Assumir</button>}
              <button type="button" className="secondary" onClick={beginTreatment}><Pencil style={{ width: 13, height: 13 }} />Tratativa</button>
              <button type="button" className="secondary" onClick={() => begin('assign')}><UserCheck />Responsável</button>
              <button type="button" className="secondary" onClick={() => begin('priority')}>Prioridade</button>
              <button type="button" className="secondary" onClick={() => begin('due')}>Prazo</button>
            </>
          )}
          {user.role === 'ADMIN' && (
            <button
              type="button"
              className="secondary"
              onClick={() => { setTargetDepartment(record.department ?? ''); begin('department'); }}
              title={record.department ? 'Alterar setor do caso' : 'Definir setor para o caso'}
            >
              <Building2 style={{ width: 13, height: 13 }} />
              {record.department ? 'Alterar setor' : 'Definir setor'}
            </button>
          )}
        </div>
      </div>
      {record.operational.attentionReasons.length > 0 && <div className="modal-attention" aria-label="Motivos de atenção">{record.operational.attentionReasons.map(reasonCode => <span key={reasonCode}>{attentionLabels[reasonCode]}</span>)}</div>}
    </div>
    <nav className="tabs" aria-label="Conteúdo do caso">{tabs.map(value => <button type="button" key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{value}</button>)}</nav>
    <div className="modal-body operational-body">{error && <div className="inline-error" role="alert">{error}<button onClick={() => setError('')}>Fechar</button></div>}
      {tab === 'Detalhes' && <section className="case-details">
        <dl>
          <div>
            <dt>Setor</dt>
            <dd style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600 }}>{record.department || 'Sem setor definido'}</span>
              {user.role === 'ADMIN' && (
                <button
                  type="button"
                  className="secondary"
                  style={{ fontSize: '11px', padding: '2px 8px' }}
                  onClick={() => { setTargetDepartment(record.department ?? ''); begin('department'); }}
                >
                  {record.department ? 'Alterar setor' : 'Definir setor'}
                </button>
              )}
            </dd>
          </div>
          <div><dt>Canal</dt><dd>{record.channelCatalog?.name ?? 'Não informado'}</dd></div>
          <div><dt>Abertura da ocorrência</dt><dd>{formatDate(record.openedAt)}</dd></div>
          <div><dt>Criação no sistema</dt><dd>{formatDate(record.createdAt ?? record.openedAt)}</dd></div>
          <div><dt>Tempo em aberto</dt><dd>{getOpenDuration(record)}</dd></div>
          {record.completedAt && (
            <div><dt>Encerramento</dt><dd>{formatDate(record.completedAt)}</dd></div>
          )}
          <div><dt>Última atualização</dt><dd>{formatDate(record.updatedAt)}</dd></div>
          <div><dt>Protocolo externo</dt><dd>{record.externalTicket ?? 'Não informado'}</dd></div>
          {record.customer?.document && (
            <div>
              <dt>CPF / CNPJ do cliente</dt>
              <dd style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span>{record.customer.document}</span>
                {record.customer.isDocumentMasked ? (
                  <>
                    <span className="sac-masked-badge">
                      <Lock style={{ width: 10, height: 10 }} /> Mascarado
                    </span>
                    {user.role === 'ADMIN' && (
                      <button
                        type="button"
                        className="sac-reveal-btn"
                        disabled={revealingCustomerDoc}
                        onClick={revealCustomerDoc}
                        title="Revelar documento completo (ação auditada)"
                      >
                        {revealingCustomerDoc ? <LoaderCircle className="spin" style={{ width: 12, height: 12 }} /> : <Eye style={{ width: 12, height: 12 }} />}
                        Revelar
                      </button>
                    )}
                  </>
                ) : (
                  user.role === 'ADMIN' && (
                    <button
                      type="button"
                      className="sac-reveal-btn sac-hide-btn"
                      onClick={hideCustomerDoc}
                      title="Ocultar documento sensível"
                    >
                      <EyeOff style={{ width: 12, height: 12 }} />
                      Ocultar
                    </button>
                  )
                )}
              </dd>
            </div>
          )}
        </dl>
        {record.references && record.references.length > 0 && (
          <article style={{ marginTop: '12px', marginBottom: '12px' }}>
            <strong>Referências do caso ({record.references.length})</strong>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' }}>
              {record.references.map(ref => (
                <span key={ref.id} className="sac-reference-badge" title={ref.note || undefined}>
                  <strong>{SAC_REFERENCE_LABELS[ref.type] || ref.type}:</strong> {ref.value}
                  {ref.note && <small style={{ opacity: 0.8, marginLeft: 4 }}>({ref.note})</small>}
                </span>
              ))}
            </div>
          </article>
        )}
        <article><strong>Descrição</strong><p>{record.description}</p></article>
        {record.internalNote && <article><strong>Observação interna</strong><p>{record.internalNote}</p></article>}

        <section className="case-treatment-section" style={{
          marginTop: '16px',
          marginBottom: '16px',
          border: '1px solid #d0dbe7',
          borderRadius: '8px',
          background: '#ffffff',
          overflow: 'hidden'
        }}>
          <header style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '12px 16px',
            background: '#f8fafc',
            borderBottom: '1px solid #e2e8f0'
          }}>
            <div>
              <h3 style={{ margin: 0, fontSize: '13px', fontWeight: 700, color: '#0f172a' }}>
                {record.status === 'COMPLETED' ? 'Conclusão e Resolução do Caso' : 'Tratativa e Resposta Operacional'}
              </h3>
              <p style={{ margin: '2px 0 0', fontSize: '11px', color: '#64748b' }}>
                {record.status === 'COMPLETED'
                  ? `Caso concluído${record.completedAt ? ` em ${formatDate(record.completedAt)}` : ''}`
                  : 'Posicionamento formal ao cliente e análise técnica interna pós-abertura'}
              </p>
            </div>
            {user.role !== 'VIEWER' && canWriteCases && (record.status === 'PENDING' || record.status === 'IN_PROGRESS') && (
              <button
                type="button"
                className="secondary"
                onClick={beginTreatment}
                style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '6px 12px' }}
              >
                <Pencil style={{ width: 13, height: 13 }} />
                {record.solutionSummary || record.identifiedCause || record.correctiveAction ? 'Editar tratativa' : 'Registrar tratativa'}
              </button>
            )}
          </header>

          <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {/* Resposta / Tratativa dada */}
            <div style={{
              background: record.solutionSummary ? '#f0fdf4' : '#f8fafc',
              border: `1px solid ${record.solutionSummary ? '#bbf7d0' : '#e2e8f0'}`,
              borderRadius: '6px',
              padding: '12px 14px'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                <CheckCircle2 style={{ width: 15, height: 15, color: record.solutionSummary ? '#16a34a' : '#94a3b8' }} />
                <strong style={{ fontSize: '12px', color: '#0f172a' }}>Resposta / Tratativa dada</strong>
              </div>
              <p style={{
                fontSize: '13px',
                color: record.solutionSummary ? '#1e293b' : '#64748b',
                lineHeight: 1.55,
                margin: 0,
                whiteSpace: 'pre-wrap',
                fontStyle: record.solutionSummary ? 'normal' : 'italic'
              }}>
                {record.solutionSummary || 'Nenhuma resposta ou tratativa registrada até o momento.'}
              </p>
            </div>

            {/* Análise Técnica Interna (Causa, Área, Ação Corretiva) */}
            <div>
              <h4 style={{ margin: '0 0 10px', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', color: '#64748b' }}>
                Análise Técnica Interna
              </h4>
              <div className="case-conclusion" style={{ margin: 0 }}>
                <article style={{ margin: 0 }}>
                  <strong>Causa identificada</strong>
                  <p style={{ color: record.identifiedCause ? '#334155' : '#94a3b8', fontStyle: record.identifiedCause ? 'normal' : 'italic' }}>
                    {record.identifiedCause || 'Não informada'}
                  </p>
                </article>
                <article style={{ margin: 0 }}>
                  <strong>Área responsável</strong>
                  <p style={{ color: record.responsibleArea ? '#334155' : '#94a3b8', fontStyle: record.responsibleArea ? 'normal' : 'italic' }}>
                    {record.responsibleArea || 'Não informada'}
                  </p>
                </article>
                <article style={{ margin: 0, gridColumn: 'span 2' }}>
                  <strong>Ação corretiva</strong>
                  <p style={{ color: record.correctiveAction ? '#334155' : '#94a3b8', fontStyle: record.correctiveAction ? 'normal' : 'italic' }}>
                    {record.correctiveAction || 'Não informada'}
                  </p>
                </article>
              </div>
            </div>
          </div>
        </section>
      </section>}
      {tab === 'Itens' && <section className="modal-section"><div className="section-heading"><div><h3>Itens relacionados</h3><p>{record.items.length} item(ns) registrado(s)</p></div></div>{record.items.length ? <div className="compact-table"><table><thead><tr><th>Código</th><th>Descrição</th><th>Lote</th><th>Quantidade</th></tr></thead><tbody>{record.items.map(item => <tr key={item.id}><td>{item.code}</td><td>{item.description}</td><td>{item.batch ?? '—'}</td><td>{item.quantity}</td></tr>)}</tbody></table></div> : <div className="empty-state"><FileText /><strong>Nenhum item relacionado</strong></div>}</section>}
      {tab === 'Evidências' && <section className="modal-section"><div className="section-heading"><div><h3>Evidências anexadas</h3><p>Arquivos preservados no registro ({record.attachments.length})</p></div></div>{record.attachments.length ? <div className="attachment-list">{record.attachments.map(file => { const isQuarantined = file.status && file.status !== 'ACTIVE'; return <article key={file.id} className={`attachment-item${isQuarantined ? ' attachment-unavailable' : ''}`}><span className="file-icon"><Paperclip aria-hidden="true" /></span><div className="attachment-details"><strong>{file.originalName}</strong><small>{file.mimeType} · {(file.sizeBytes / 1024).toFixed(1)} KB{file.author?.name ? ` · Enviado por ${file.author.name}` : ''}{file.createdAt ? ` · ${formatDate(file.createdAt)}` : ''}</small>{isQuarantined && <span className="badge badge-pendente" style={{ marginTop: '5px' }}>Indisponível (Quarentena)</span>}</div><button type="button" className="secondary attachment-download-btn" disabled={Boolean(isQuarantined || downloadingId === file.id)} onClick={() => handleDownload(file.id, file.originalName)} aria-label={`Baixar evidência ${file.originalName}`}>{downloadingId === file.id ? <LoaderCircle className="spin" aria-hidden="true" /> : <Download aria-hidden="true" />}<span>{downloadingId === file.id ? 'Baixando...' : 'Baixar'}</span></button></article>; })}</div> : <div className="empty-state"><Paperclip /><strong>Nenhuma evidência anexada</strong><span>Nenhum arquivo de evidência foi anexado a este caso.</span></div>}</section>}
      {tab === 'Histórico' && <section className="history-section"><form className="comment-form" onSubmit={sendComment}><label htmlFor="case-comment">Comentário interno</label><textarea id="case-comment" value={comment} maxLength={4000} disabled={user.role === 'VIEWER'} onChange={event => setComment(event.target.value)} placeholder={user.role === 'VIEWER' ? 'Perfil de consulta não pode comentar.' : 'Registre uma atualização objetiva...'} /><div><small>{comment.length}/4000</small>{user.role !== 'VIEWER' && <button className="primary" disabled={!comment.trim() || saving}><MessageSquare />Adicionar comentário</button>}</div></form><div className="timeline timeline-expanded"><h3>Linha do tempo</h3>{timeline.map(item => 'comment' in item ? <div key={item.id}><i className="dot magenta" /><time>{formatDate(item.createdAt)}</time><p><strong>Comentário de {item.comment.author.name}</strong><span>{item.comment.body}</span></p></div> : <div key={item.id}><i className="dot" /><time>{formatDate(item.createdAt)}</time><p><strong>{item.activity.summary}</strong><span>Por {item.activity.actor.name}</span></p></div>)}{!timeline.length && <div className="empty-state"><CheckCircle2 /><strong>Nenhum evento registrado</strong></div>}</div>{history && history.page * history.pageSize < history.total && <button className="secondary history-more" onClick={() => setHistoryPage(value => value + 1)}>Carregar mais</button>}</section>}
    </div>
    <footer className="operational-actions">{actions.map(action => <button type="button" key={action} className={action === 'cancel' ? 'sac-danger-action' : 'primary'} onClick={() => begin(action)}>{operationLabels[action]}</button>)}</footer>
    {operation && <form className="operation-panel" onSubmit={execute}><header><div><strong>{operation === 'department' ? (record.department ? 'Alterar setor' : 'Definir setor') : operationLabels[operation]}</strong><span>{operation === 'department' ? (record.department ? 'Transfira este caso para outro setor responsável.' : 'Classifique e atribua um setor responsável para o caso.') : 'Confirme os dados desta ação operacional.'}</span></div><button type="button" className="icon-btn" disabled={saving} onClick={() => setOperation(null)} aria-label="Fechar ação"><X /></button></header>{error && <div className="inline-error" role="alert" style={{ marginBottom: '14px' }}>{error}<button type="button" onClick={() => setError('')}>Fechar</button></div>}{operation === 'department' && <div className="operation-grid"><label style={{ gridColumn: 'span 2' }}>{record.department ? 'Novo setor *' : 'Setor *'}<select value={targetDepartment} onChange={event => setTargetDepartment(event.target.value)} required disabled={saving}><option value="">Selecione o setor</option>{departments.map(dept => <option value={dept} key={dept}>{dept}</option>)}</select></label><label style={{ gridColumn: 'span 2' }}>Justificativa {record.department ? 'da alteração' : 'da definição'} de setor<textarea value={reason} maxLength={2000} placeholder={record.department ? 'Motivo da transferência ou alteração...' : 'Motivo da classificação do setor...'} onChange={event => setReason(event.target.value)} disabled={saving} /></label></div>}{operation === 'assign' && <label>Responsável<select value={assigneeId} onChange={event => setAssigneeId(event.target.value)}><option value="">Sem responsável</option>{assignees.map(option => <option value={option.id} key={option.id}>{option.name}</option>)}</select></label>}{operation === 'priority' && <label>Nova prioridade<select value={priority} onChange={event => setPriority(event.target.value as OperationalRecord['priority'])}>{Object.entries(priorityLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>}{operation === 'due' && <label>Novo prazo<input type="date" value={dueAt} min={dateInput(record.openedAt)} onChange={event => setDueAt(event.target.value)} /></label>}{operation === 'treatment' && <div className="operation-grid"><label style={{ gridColumn: 'span 2' }}>Resposta / Tratativa dada ao cliente ou caso *<textarea value={solution} maxLength={5000} required placeholder="Descreva a resposta fornecida ao cliente ou a resolução operacional aplicada..." onChange={event => setSolution(event.target.value)} rows={4} /></label><label>Causa identificada<textarea value={cause} maxLength={2000} placeholder="Causa raiz ou origem constatada..." onChange={event => setCause(event.target.value)} rows={2} /></label><label>Área responsável<input value={area} maxLength={160} placeholder="Área ou setor responsável..." onChange={event => setArea(event.target.value)} /></label><label style={{ gridColumn: 'span 2' }}>Ação corretiva<textarea value={corrective} maxLength={2000} placeholder="Ação corretiva ou melhoria executada..." onChange={event => setCorrective(event.target.value)} rows={2} /></label></div>}{operation === 'complete' && <div className="operation-grid"><label style={{ gridColumn: 'span 2' }}>Resumo da solução e conclusão definitiva *<textarea value={solution} maxLength={5000} required placeholder="Descreva o desfecho da tratativa e encerramento do caso..." onChange={event => setSolution(event.target.value)} rows={3} /></label><label>Causa identificada<textarea value={cause} maxLength={2000} placeholder="Causa apurada (opcional)..." onChange={event => setCause(event.target.value)} rows={2} /></label><label>Área responsável<input value={area} maxLength={160} placeholder="Setor responsável (opcional)..." onChange={event => setArea(event.target.value)} /></label><label style={{ gridColumn: 'span 2' }}>Ação corretiva<textarea value={corrective} maxLength={2000} placeholder="Ação preventiva ou corretiva (opcional)..." onChange={event => setCorrective(event.target.value)} rows={2} /></label></div>}{needsReason && <label>Justificativa *<textarea value={reason} maxLength={2000} required onChange={event => setReason(event.target.value)} /></label>}<label className="operation-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={saving} />Confirmo esta alteração e seu registro no histórico.</label><footer><button type="button" className="secondary" disabled={saving} onClick={() => setOperation(null)}>Voltar</button><button className="primary" disabled={!confirmed || saving || (operation === 'department' && !targetDepartment.trim())}>{saving ? 'Salvando...' : 'Confirmar'}</button></footer></form>}
  </section></div>;
}
