import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Filter, LoaderCircle, MoreHorizontal, Plus, Search, ShieldCheck, UserCheck, Users, X } from 'lucide-react';
import { apiRequest } from './api';

type Role = 'ADMIN' | 'ANALYST' | 'VIEWER';
type TeamUser = { id: string; name: string; email: string; role: Role; active: boolean; approvedAt: string | null; rejectedAt: string | null; lastLoginAt: string | null; createdAt: string; openAssignedCases: number; mustChangePassword?: boolean };
type TeamPageData = { items: TeamUser[]; total: number; page: number; pageSize: number };
type Summary = { activeUsers: number; pendingApproval: number; analysts: number; unassignedCases: number };
type Action = 'approve' | 'reject' | 'role' | 'deactivate' | 'reactivate' | 'resend-provisional';
type Option = { id: string; name: string };
type Audit = { id: string; type: string; justification: string | null; createdAt: string; actor: { name: string } | null };
type Filters = { query: string; role: string; state: string; approval: string; sort: string; order: string };
const initialFilters: Filters = { query: '', role: 'all', state: 'all', approval: 'all', sort: 'name', order: 'asc' };
const roleLabel: Record<Role, string> = { ADMIN: 'Administrador', ANALYST: 'Analista', VIEWER: 'Consulta' };
const auditLabel: Record<string, string> = {
  ACCESS_REQUESTED: 'Acesso solicitado',
  ACCESS_APPROVED: 'Acesso aprovado',
  ACCESS_REJECTED: 'Solicitação recusada',
  ROLE_CHANGED: 'Perfil alterado',
  USER_DEACTIVATED: 'Usuário inativado',
  USER_REACTIVATED: 'Usuário reativado',
  CASES_TRANSFERRED: 'Casos redistribuídos',
  PASSWORD_CHANGED: 'Senha alterada',
  LAST_ADMIN_BLOCKED: 'Proteção do último administrador acionada',
  PROVISIONAL_PASSWORD_GENERATED: 'Senha provisória gerada',
  PROVISIONAL_PASSWORD_RESENT: 'Senha provisória reenviada',
};
const formatDate = (value: string | null) => value ? new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'Nunca';
const initials = (name: string) => name.split(/\s+/).map(value => value[0]).slice(0, 2).join('').toUpperCase();
function accountState(user: TeamUser) {
  if (user.rejectedAt) return { key: 'rejected', label: 'Recusado' };
  if (!user.approvedAt) {
    if (user.mustChangePassword && !user.active) {
      return { key: 'preview-pending', label: 'E-mail não enviado · Conta inativa' };
    }
    return { key: 'pending', label: 'Aguardando aprovação' };
  }
  if (!user.active) return { key: 'inactive', label: 'Inativo' };
  if (user.mustChangePassword) return { key: 'provisional', label: 'Primeiro acesso pendente' };
  return { key: 'active', label: 'Ativo' };
}

export function TeamManagementPage({
  currentUser,
  requestedApproval,
  onRequestHandled,
  onMessage
}: {
  currentUser?: { id: string; role: Role; name?: string; email?: string };
  requestedApproval?: 'pending';
  onRequestHandled: () => void;
  onMessage: (message: string) => void;
}) {
  const [filters, setFilters] = useState(initialFilters);
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<TeamPageData>({ items: [], total: 0, page: 1, pageSize: 20 });
  const [summary, setSummary] = useState<Summary>({ activeUsers: 0, pendingApproval: 0, analysts: 0, unassignedCases: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selected, setSelected] = useState<TeamUser | null>(null);
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const openerRef = useRef<HTMLElement | null>(null);
  const filterTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { const timer = setTimeout(() => { setDebouncedQuery(filters.query); setPage(1); }, 300); return () => clearTimeout(timer); }, [filters.query]);
  useEffect(() => { if (requestedApproval === 'pending') { setFilters(current => ({ ...current, approval: 'pending' })); setPage(1); onRequestHandled(); } }, [requestedApproval, onRequestHandled]);
  useEffect(() => { apiRequest<Summary>('/users/summary').then(setSummary).catch(() => undefined); }, [reload]);
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ ...filters, query: debouncedQuery, page: String(page), pageSize: '20' });
    setLoading(true);
    setError('');
    apiRequest<TeamPageData>(`/users?${query}`, { signal: controller.signal })
      .then(setData)
      .catch(reason => { if ((reason as Error).name !== 'AbortError') setError('Não foi possível carregar a equipe.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filters.role, filters.state, filters.approval, filters.sort, filters.order, debouncedQuery, page, reload]);

  useEffect(() => {
    if (!filtersOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFiltersOpen(false);
        requestAnimationFrame(() => filterTriggerRef.current?.focus());
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [filtersOpen]);

  const updateFilter = (key: keyof Filters, value: string) => { setFilters(current => ({ ...current, [key]: value })); setPage(1); };
  const openUser = (user: TeamUser) => {
    // Não permite abrir modal de alteração para a própria conta nem para outro administrador
    if (currentUser && user.id === currentUser.id) return;
    if (user.role === 'ADMIN') return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelected(user);
  };
  const closeUser = () => { setSelected(null); requestAnimationFrame(() => openerRef.current?.focus()); };
  const changed = (message: string) => { closeUser(); setReload(value => value + 1); onMessage(message); };

  return <>
    <header className="page-header page-title page-title-row">
      <div className="page-header-copy">
        <h1>Equipe</h1>
        <p>Gerencie solicitações, perfis e o ciclo de vida das contas.</p>
      </div>
    </header>

    <section className="team-kpis" aria-label="Indicadores da equipe">
      <article><UserCheck /><div><strong>{summary.activeUsers}</strong><span>Usuários ativos</span></div></article>
      <article><ShieldCheck /><div><strong>{summary.pendingApproval}</strong><span>Aguardando aprovação</span></div></article>
      <article><Users /><div><strong>{summary.analysts}</strong><span>Analistas</span></div></article>
      <article><AlertTriangle /><div><strong>{summary.unassignedCases}</strong><span>Casos sem responsável</span></div></article>
    </section>

    <section className="team-card">
      <header>
        <div>
          <h2>Membros da equipe</h2>
          <span>{data.total} {data.total === 1 ? 'usuário' : 'usuários'}</span>
        </div>
        <div className="team-search">
          <Search aria-hidden="true" />
          <input value={filters.query} onChange={event => updateFilter('query', event.target.value)} placeholder="Buscar nome ou e-mail" aria-label="Buscar usuário" />
        </div>
        <div className="team-card-actions">
          <button type="button" className="primary" onClick={() => setAddUserOpen(true)}>
            <Plus aria-hidden="true" />
            <span>Adicionar usuário</span>
          </button>
          <button ref={filterTriggerRef} className="secondary team-filter-trigger" aria-expanded={filtersOpen} aria-controls="team-filters" onClick={() => setFiltersOpen(value => !value)}>
            <Filter />
            Filtros
          </button>
        </div>
      </header>

      <div id="team-filters" className={`team-filters${filtersOpen ? ' is-open' : ''}`}>
        <div className="team-filter-head">
          <strong>Filtros</strong>
          <button aria-label="Fechar filtros" onClick={() => setFiltersOpen(false)}><X /></button>
        </div>
        <label>Perfil<select value={filters.role} onChange={event => updateFilter('role', event.target.value)}><option value="all">Todos</option><option value="ADMIN">Administrador</option><option value="ANALYST">Analista</option><option value="VIEWER">Consulta</option></select></label>
        <label>Estado<select value={filters.state} onChange={event => updateFilter('state', event.target.value)}><option value="all">Todos</option><option value="active">Ativos</option><option value="inactive">Inativos</option></select></label>
        <label>Aprovação<select value={filters.approval} onChange={event => updateFilter('approval', event.target.value)}><option value="all">Todas</option><option value="pending">Aguardando aprovação</option><option value="approved">Aprovadas</option><option value="rejected">Recusadas</option></select></label>
        <label>Ordenação<select value={filters.sort} onChange={event => updateFilter('sort', event.target.value)}><option value="name">Nome</option><option value="createdAt">Cadastro</option><option value="lastLoginAt">Último acesso</option><option value="role">Perfil</option></select></label>
        <label>Direção<select value={filters.order} onChange={event => updateFilter('order', event.target.value)}><option value="asc">Crescente</option><option value="desc">Decrescente</option></select></label>
        <button className="secondary" onClick={() => { setFilters(initialFilters); setDebouncedQuery(''); setPage(1); }}>Limpar</button>
      </div>

      {error ? (
        <div className="team-state" role="alert">
          <AlertTriangle />
          <strong>{error}</strong>
          <button className="secondary" onClick={() => setReload(value => value + 1)}>Tentar novamente</button>
        </div>
      ) : loading ? (
        <div className="team-state" role="status">
          <LoaderCircle className="spin" />
          Carregando equipe...
        </div>
      ) : !data.items.length ? (
        <div className="team-state">
          <Users />
          <strong>Nenhum usuário encontrado</strong>
          <span>Ajuste os filtros ou aguarde novas solicitações.</span>
        </div>
      ) : (
        <>
          <div className="team-table-wrap">
            <table className="team-management-table">
              <thead>
                <tr>
                  <th>Usuário</th>
                  <th>Perfil</th>
                  <th>Estado</th>
                  <th>Casos abertos</th>
                  <th>Último acesso</th>
                  <th>Cadastro</th>
                  <th><span className="sr-only">Ações</span></th>
                </tr>
              </thead>
              <tbody>
                {data.items.map(user => {
                  const state = accountState(user);
                  const isSelf = currentUser && user.id === currentUser.id;
                  const isOtherAdmin = user.role === 'ADMIN' && !isSelf;

                  return (
                    <tr key={user.id}>
                      <td>
                        <span className="team-person">
                          <span className="avatar">{initials(user.name)}</span>
                          <span>
                            <strong>{user.name}</strong>
                            <small>{user.email}</small>
                          </span>
                        </span>
                      </td>
                      <td>{roleLabel[user.role]}</td>
                      <td>
                        <span className={`account-state state-${state.key}`}>{state.label}</span>
                      </td>
                      <td>{user.openAssignedCases}</td>
                      <td>{formatDate(user.lastLoginAt)}</td>
                      <td>{formatDate(user.createdAt)}</td>
                      <td>
                        {isSelf ? (
                          <span className="team-self-badge">Sua conta</span>
                        ) : isOtherAdmin ? (
                          <span className="team-protected-badge" title="Administrador protegido contra alterações">Administrador</span>
                        ) : (
                          <button className="icon-btn" aria-label={`Gerenciar ${user.name}`} onClick={() => openUser(user)}>
                            <MoreHorizontal />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="team-mobile-list">
            {data.items.map(user => {
              const state = accountState(user);
              const isSelf = currentUser && user.id === currentUser.id;
              const isOtherAdmin = user.role === 'ADMIN' && !isSelf;

              return (
                <article key={user.id}>
                  <header>
                    <span className="team-person">
                      <span className="avatar">{initials(user.name)}</span>
                      <span>
                        <strong>{user.name}</strong>
                        <small>{user.email}</small>
                      </span>
                    </span>
                    {isSelf ? (
                      <span className="team-self-badge">Sua conta</span>
                    ) : isOtherAdmin ? (
                      <span className="team-protected-badge" title="Administrador protegido">Administrador</span>
                    ) : (
                      <button className="icon-btn" aria-label={`Gerenciar ${user.name}`} onClick={() => openUser(user)}>
                        <MoreHorizontal />
                      </button>
                    )}
                  </header>
                  <div>
                    <span>{roleLabel[user.role]}</span>
                    <span className={`account-state state-${state.key}`}>{state.label}</span>
                  </div>
                  <small>{user.openAssignedCases} casos abertos · Último acesso: {formatDate(user.lastLoginAt)}</small>
                </article>
              );
            })}
          </div>
        </>
      )}

      {data.total > data.pageSize && (
        <footer className="team-pagination">
          <span>Página {page} de {Math.ceil(data.total / data.pageSize)}</span>
          <div>
            <button className="secondary" disabled={page === 1} aria-label="Página anterior" onClick={() => setPage(value => value - 1)}>
              <ChevronLeft />
            </button>
            <button className="secondary" disabled={page * data.pageSize >= data.total} aria-label="Próxima página" onClick={() => setPage(value => value + 1)}>
              <ChevronRight />
            </button>
          </div>
        </footer>
      )}
    </section>

    {selected && <UserManagementModal user={selected} onClose={closeUser} onChanged={changed} />}
    {addUserOpen && (
      <AddUserModal
        onClose={() => setAddUserOpen(false)}
        onCreated={msg => {
          setAddUserOpen(false);
          setReload(v => v + 1);
          onMessage(msg);
        }}
      />
    )}
  </>;
}

function AddUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: (message: string) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'ANALYST' | 'VIEWER'>('ANALYST');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const modalRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const res = await apiRequest<{ emailDelivery?: { delivered: boolean; statusMessage: string } }>(
        '/users',
        {
          method: 'POST',
          body: JSON.stringify({ name: name.trim(), email: email.trim(), role }),
        }
      );
      if (res?.emailDelivery && !res.emailDelivery.delivered) {
        onCreated('E-mail não enviado; conta inativa');
      } else {
        onCreated('Envio aceito pelo servidor de e-mail; conta ativada.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível cadastrar o usuário.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="overlay team-modal-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section ref={modalRef} className="modal team-add-user-modal" role="dialog" aria-modal="true" aria-labelledby="add-user-title">
        <header className="modal-head">
          <div>
            <h2 id="add-user-title">Adicionar usuário</h2>
            <p>Cadastre um novo membro com perfil operacional e primeiro acesso por e-mail.</p>
          </div>
          <button className="icon-btn" aria-label="Fechar cadastro" onClick={onClose}>
            <X />
          </button>
        </header>
        <form onSubmit={submit}>
          <div className="modal-body">
            <label>
              Nome completo
              <input
                required
                minLength={3}
                maxLength={120}
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Ex.: Mariana Fernandes"
              />
            </label>
            <label>
              E-mail corporativo
              <input
                type="email"
                required
                maxLength={254}
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="Ex.: mariana@empresa.com"
              />
            </label>
            <label>
              Perfil operacional
              <select value={role} onChange={e => setRole(e.target.value as 'ANALYST' | 'VIEWER')}>
                <option value="ANALYST">Analista</option>
                <option value="VIEWER">Consulta</option>
              </select>
            </label>
            <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', margin: '4px 0 0', lineHeight: 1.45 }}>
              O usuário é cadastrado como inativo e uma senha provisória aleatória é enviada por e-mail. A conta só será ativada após o servidor de e-mail aceitar o envio.
            </p>
            {error && <p className="inline-error" role="alert">{error}</p>}
          </div>
          <footer className="form-footer">
            <button type="button" className="secondary" onClick={onClose}>
              Cancelar
            </button>
            <button className="primary" disabled={saving}>
              {saving ? 'Cadastrando...' : 'Cadastrar usuário'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function UserManagementModal({ user, onClose, onChanged }: { user: TeamUser; onClose: () => void; onChanged: (message: string) => void }) {
  const isPreviewPending = !user.approvedAt && Boolean(user.mustChangePassword) && !user.active;
  const initialAction: Action = !user.approvedAt && !user.rejectedAt ? 'approve' : user.active ? 'role' : user.approvedAt ? 'reactivate' : 'approve';
  const [action, setAction] = useState<Action>(initialAction);
  // Inicializar o campo Perfil com o perfil real do usuário selecionado
  const [role, setRole] = useState<Role>(user.role);
  const [reason, setReason] = useState('');
  const [strategy, setStrategy] = useState<'transfer' | 'unassigned'>('transfer');
  const [transferTo, setTransferTo] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [assignees, setAssignees] = useState<Option[]>([]);
  const [audits, setAudits] = useState<Audit[]>([]);
  const modalRef = useRef<HTMLElement>(null);

  useEffect(() => {
    apiRequest<Audit[]>(`/users/${user.id}/audits`).then(setAudits).catch(() => undefined);
    if (user.openAssignedCases) apiRequest<Option[]>('/users/assignable').then(items => setAssignees(items.filter(item => item.id !== user.id))).catch(() => undefined);
    const focusable = () => Array.from(modalRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),textarea:not(:disabled),input:not(:disabled),summary') ?? []).filter(item => item.getClientRects().length > 0);
    requestAnimationFrame(() => focusable()[0]?.focus());
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { onClose(); return; }
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [user.id, user.openAssignedCases, onClose]);

  // Exibir justificativa somente nas ações que efetivamente a exigem
  const needsReason =
    action === 'reject' ||
    action === 'deactivate' ||
    action === 'reactivate' ||
    (action === 'role' && user.role === 'ANALYST' && role === 'VIEWER');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!confirmed || saving) return;
    setSaving(true);
    setError('');
    try {
      let path = '';
      let method = 'POST';
      let body: Record<string, unknown> = {};

      if (action === 'approve') {
        path = `/users/${user.id}/approve`;
        body = { role };
      } else if (action === 'resend-provisional') {
        path = `/users/${user.id}/resend-provisional`;
      } else if (action === 'reject') {
        path = `/users/${user.id}/reject`;
        body = { justification: reason };
      } else if (action === 'role') {
        path = `/users/${user.id}/role`;
        method = 'PATCH';
        body = { role, justification: needsReason ? reason : undefined };
      } else if (action === 'deactivate') {
        path = `/users/${user.id}/deactivate`;
        body = {
          justification: reason,
          ...(user.openAssignedCases ? { strategy, transferToUserId: strategy === 'transfer' ? transferTo : undefined, confirmUnassigned: strategy === 'unassigned' } : {})
        };
      } else if (action === 'reactivate') {
        path = `/users/${user.id}/reactivate`;
        body = { justification: reason };
      }

      const res = await apiRequest<{ emailDelivery?: { delivered: boolean; statusMessage: string } }>(
        path,
        { method, body: Object.keys(body).length ? JSON.stringify(body) : undefined }
      );

      if (res?.emailDelivery && !res.emailDelivery.delivered) {
        onChanged(
          action === 'resend-provisional'
            ? 'E-mail não enviado; credenciais anteriores preservadas'
            : 'E-mail não enviado; conta inativa'
        );
      } else {
        onChanged(
          action === 'approve'
            ? 'Envio aceito pelo servidor de e-mail; conta ativada.'
            : action === 'resend-provisional'
            ? 'Envio aceito pelo servidor de e-mail.'
            : action === 'reject'
            ? 'Solicitação recusada.'
            : action === 'role'
            ? 'Perfil atualizado.'
            : action === 'deactivate'
            ? 'Usuário inativado.'
            : 'Usuário reativado.'
        );
      }
    } catch (reasonError) {
      setError(reasonError instanceof Error ? reasonError.message : 'Não foi possível concluir a ação.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overlay team-modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={modalRef} className="modal team-user-modal" role="dialog" aria-modal="true" aria-labelledby="manage-user-title">
        <header className="modal-head">
          <div>
            <h2 id="manage-user-title">Gerenciar usuário</h2>
            <p>{user.name} · {user.email}</p>
          </div>
          <button className="icon-btn" aria-label="Fechar gestão do usuário" onClick={onClose}>
            <X />
          </button>
        </header>
        <form onSubmit={submit}>
          <div className="modal-body">
            <label>
              Ação
              <select
                value={action}
                onChange={event => {
                  setAction(event.target.value as Action);
                  setConfirmed(false);
                  setError('');
                }}
              >
                {!user.approvedAt && <option value="approve">{isPreviewPending ? 'Tentar aprovação novamente (reenviar por e-mail)' : 'Aprovar acesso'}</option>}
                {!user.approvedAt && <option value="reject">Recusar solicitação</option>}
                {user.approvedAt && user.active && <option value="resend-provisional">Reenviar senha provisória</option>}
                {user.approvedAt && <option value="role">Alterar perfil</option>}
                {user.active && <option value="deactivate">Inativar</option>}
                {!user.active && user.approvedAt && <option value="reactivate">Reativar</option>}
              </select>
            </label>

            {(action === 'approve' || action === 'role') && (
              <label>
                Perfil
                <select
                  value={role}
                  onChange={event => {
                    setRole(event.target.value as Role);
                    setConfirmed(false);
                    setError('');
                  }}
                >
                  <option value="ANALYST">Analista</option>
                  <option value="VIEWER">Consulta</option>
                </select>
              </label>
            )}

            {isPreviewPending && action === 'approve' && (
              <p style={{ fontSize: '13px', color: 'var(--color-muted)', margin: '8px 0' }}>
                Tentativa de aprovação: uma nova senha provisória será gerada e o envio por e-mail será tentado novamente. A conta só será ativada se o servidor de e-mail aceitar o envio.
              </p>
            )}

            {action === 'resend-provisional' && (
              <p style={{ fontSize: '13px', color: 'var(--color-muted)', margin: '8px 0' }}>
                Uma nova senha provisória será gerada e enviada para <strong>{user.email}</strong>. As credenciais e sessões atuais são preservadas se o envio não for aceito.
              </p>
            )}

            {needsReason && (
              <label>
                Justificativa
                <textarea
                  required
                  minLength={5}
                  maxLength={500}
                  value={reason}
                  onChange={event => setReason(event.target.value)}
                  placeholder="Descreva o motivo desta alteração..."
                />
              </label>
            )}

            {action === 'deactivate' && user.openAssignedCases > 0 && (
              <fieldset>
                <legend>Destino de {user.openAssignedCases} casos abertos</legend>
                <label>
                  <input type="radio" checked={strategy === 'transfer'} onChange={() => setStrategy('transfer')} />
                  Transferir para outro responsável
                </label>
                {strategy === 'transfer' && (
                  <label>
                    Responsável
                    <select required value={transferTo} onChange={event => setTransferTo(event.target.value)}>
                      <option value="">Selecione</option>
                      {assignees.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
                    </select>
                  </label>
                )}
                <label>
                  <input type="radio" checked={strategy === 'unassigned'} onChange={() => setStrategy('unassigned')} />
                  Deixar sem responsável
                </label>
              </fieldset>
            )}

            <label className="team-confirm">
              <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
              Confirmo esta alteração e seus efeitos imediatos.
            </label>

            {error && <p className="inline-error" role="alert">{error}</p>}

            {audits.length > 0 && (
              <details>
                <summary>Auditoria recente</summary>
                <ul className="team-audit-list">
                  {audits.slice(0, 8).map(item => (
                    <li key={item.id}>
                      <strong>{auditLabel[item.type] ?? item.type}</strong>
                      <span>{formatDate(item.createdAt)}{item.actor ? ` · ${item.actor.name}` : ''}</span>
                      {item.justification && <small>{item.justification}</small>}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>

          <footer className="form-footer">
            <button type="button" className="secondary" onClick={onClose}>
              Cancelar
            </button>
            <button className="primary" disabled={!confirmed || saving}>
              {saving ? 'Salvando...' : 'Confirmar alteração'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
