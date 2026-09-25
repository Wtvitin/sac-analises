import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Filter, LoaderCircle, MoreHorizontal, Pencil, Plus, Search, ShieldCheck, Trash2, UserCheck, Users, X } from 'lucide-react';
import { apiRequest } from './api';

type Role = 'ADMIN' | 'ANALYST' | 'VIEWER';
type TeamUser = { id: string; name: string; email: string; role: Role; active: boolean; approvedAt: string | null; rejectedAt: string | null; lastLoginAt: string | null; createdAt: string; openAssignedCases: number; mustChangePassword?: boolean };
type TeamPageData = { items: TeamUser[]; total: number; page: number; pageSize: number };
type Summary = { activeUsers: number; pendingApproval: number; analysts: number; unassignedCases: number };
export type EditAction = 'approve' | 'reject' | 'role' | 'resend-provisional';
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
  USER_DELETED: 'Usuário excluído',
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
export function isUserManagementProtected(user: { id: string; role: Role }, currentUser?: { id: string; role: Role }) {
  const isSelf = Boolean(currentUser && user.id === currentUser.id);
  const isOtherAdmin = user.role === 'ADMIN' && !isSelf;
  return { isSelf, isOtherAdmin, isProtected: isSelf || isOtherAdmin };
}

export function getAvailableEditActions(user: { approvedAt: string | null; rejectedAt: string | null; active: boolean; mustChangePassword?: boolean }) {
  const isPreviewPending = !user.approvedAt && Boolean(user.mustChangePassword) && !user.active;
  const actions: { value: EditAction; label: string }[] = [];
  if (!user.approvedAt) {
    actions.push({ value: 'approve', label: isPreviewPending ? 'Tentar aprovação novamente (reenviar por e-mail)' : 'Aprovar acesso' });
    actions.push({ value: 'reject', label: 'Recusar solicitação' });
  }
  if (user.approvedAt && user.active) {
    actions.push({ value: 'resend-provisional', label: 'Reenviar senha provisória' });
  }
  if (user.approvedAt) {
    actions.push({ value: 'role', label: 'Alterar perfil' });
  }
  return actions;
}

export const getAvailableModalActions = getAvailableEditActions;

export function canSubmitDelete({
  confirmed,
  openAssignedCases,
  strategy,
  transferToUserId,
  saving = false,
}: {
  confirmed: boolean;
  openAssignedCases: number;
  strategy: 'transfer' | 'unassigned';
  transferToUserId?: string;
  saving?: boolean;
}) {
  if (saving) return false;
  if (!confirmed) return false;
  if (openAssignedCases > 0 && strategy === 'transfer' && !transferToUserId) {
    return false;
  }
  return true;
}

export function accountState(user: TeamUser) {
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

export function TeamRowActions({
  user,
  onEdit,
  onDelete,
}: {
  user: TeamUser;
  onEdit: (user: TeamUser) => void;
  onDelete: (user: TeamUser) => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const updatePosition = () => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const menuWidth = 176;
    const left = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, rect.right - menuWidth));
    const top = rect.bottom + 4;
    setPosition({ top, left });
  };

  const toggle = () => {
    if (!open) updatePosition();
    setOpen(value => !value);
  };

  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    if (!open) return;
    const handleOutside = (event: MouseEvent) => {
      if (
        triggerRef.current?.contains(event.target as Node) ||
        menuRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const handleScroll = () => {
      setOpen(false);
    };
    window.addEventListener('mousedown', handleOutside);
    window.addEventListener('keydown', handleKey);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);
    return () => {
      window.removeEventListener('mousedown', handleOutside);
      window.removeEventListener('keydown', handleKey);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="team-row-actions-trigger"
        aria-label={`Gerenciar ${user.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={event => {
          event.stopPropagation();
          toggle();
        }}
      >
        <MoreHorizontal />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="team-row-actions-menu"
            role="menu"
            aria-label={`Ações de ${user.name}`}
            style={position}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onEdit(user);
              }}
            >
              <Pencil aria-hidden="true" />
              Editar
            </button>
            <button
              type="button"
              role="menuitem"
              className="team-action-danger"
              onClick={() => {
                setOpen(false);
                onDelete(user);
              }}
            >
              <Trash2 aria-hidden="true" />
              Excluir usuário
            </button>
          </div>,
          document.body
        )}
    </>
  );
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
  const isAdmin = currentUser?.role === 'ADMIN';
  const [filters, setFilters] = useState(initialFilters);
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<TeamPageData>({ items: [], total: 0, page: 1, pageSize: 20 });
  const [summary, setSummary] = useState<Summary>({ activeUsers: 0, pendingApproval: 0, analysts: 0, unassignedCases: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<TeamUser | null>(null);
  const [deletingUser, setDeletingUser] = useState<TeamUser | null>(null);
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

  const openEdit = (user: TeamUser) => {
    if (!isAdmin) return;
    if (currentUser && user.id === currentUser.id) return;
    if (user.role === 'ADMIN') return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditingUser(user);
  };

  const closeEdit = () => {
    setEditingUser(null);
    requestAnimationFrame(() => openerRef.current?.focus());
  };

  const handleEditChanged = (message: string) => {
    closeEdit();
    setReload(value => value + 1);
    onMessage(message);
  };

  const openDelete = (user: TeamUser) => {
    if (!isAdmin) return;
    if (currentUser && user.id === currentUser.id) return;
    if (user.role === 'ADMIN') return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDeletingUser(user);
  };

  const closeDelete = () => {
    setDeletingUser(null);
    requestAnimationFrame(() => openerRef.current?.focus());
  };

  const handleDeleteChanged = (message: string) => {
    closeDelete();
    setReload(value => value + 1);
    onMessage(message);
  };

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
          {isAdmin && (
            <button type="button" className="primary" onClick={() => setAddUserOpen(true)}>
              <Plus aria-hidden="true" />
              <span>Adicionar usuário</span>
            </button>
          )}
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
        <label>Estado<select value={filters.state} onChange={event => updateFilter('state', event.target.value)}><option value="all">Todos</option><option value="active">Ativos</option></select></label>
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
                  const { isSelf, isOtherAdmin } = isUserManagementProtected(user, currentUser);

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
                        ) : !isAdmin ? (
                          <span className="team-protected-badge" title="Apenas administradores podem gerenciar usuários">Somente leitura</span>
                        ) : (
                          <TeamRowActions
                            user={user}
                            onEdit={openEdit}
                            onDelete={openDelete}
                          />
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
              const { isSelf, isOtherAdmin } = isUserManagementProtected(user, currentUser);

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
                    ) : !isAdmin ? (
                      <span className="team-protected-badge" title="Apenas administradores podem gerenciar usuários">Somente leitura</span>
                    ) : (
                      <TeamRowActions
                        user={user}
                        onEdit={openEdit}
                        onDelete={openDelete}
                      />
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

    {editingUser && (
      <EditUserModal
        user={editingUser}
        onClose={closeEdit}
        onChanged={handleEditChanged}
      />
    )}
    {deletingUser && (
      <DeleteUserModal
        user={deletingUser}
        onClose={closeDelete}
        onDeleted={handleDeleteChanged}
      />
    )}
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

export function EditUserModal({
  user,
  onClose,
  onChanged,
}: {
  user: TeamUser;
  onClose: () => void;
  onChanged: (message: string) => void;
}) {
  const isPreviewPending = !user.approvedAt && Boolean(user.mustChangePassword) && !user.active;
  const availableActions = getAvailableEditActions(user);
  const defaultAction: EditAction = availableActions[0]?.value ?? (!user.approvedAt && !user.rejectedAt ? 'approve' : 'role');
  const [action, setAction] = useState<EditAction>(defaultAction);
  const [role, setRole] = useState<Role>(user.role === 'ADMIN' ? 'ANALYST' : user.role);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [audits, setAudits] = useState<Audit[]>([]);
  const modalRef = useRef<HTMLElement>(null);

  useEffect(() => {
    apiRequest<Audit[]>(`/users/${user.id}/audits`).then(setAudits).catch(() => undefined);
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
  }, [user.id, onClose]);

  const needsReason =
    action === 'reject' ||
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
            : 'Perfil atualizado.'
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
      <section ref={modalRef} className="modal team-user-modal" role="dialog" aria-modal="true" aria-labelledby="edit-user-title">
        <header className="modal-head">
          <div>
            <h2 id="edit-user-title">Editar usuário</h2>
            <p>{user.name} · {user.email}</p>
          </div>
          <button className="icon-btn" aria-label="Fechar edição do usuário" onClick={onClose}>
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
                  setAction(event.target.value as EditAction);
                  setConfirmed(false);
                  setError('');
                }}
              >
                {!user.approvedAt && <option value="approve">{isPreviewPending ? 'Tentar aprovação novamente (reenviar por e-mail)' : 'Aprovar acesso'}</option>}
                {!user.approvedAt && <option value="reject">Recusar solicitação</option>}
                {user.approvedAt && user.active && <option value="resend-provisional">Reenviar senha provisória</option>}
                {user.approvedAt && <option value="role">Alterar perfil</option>}
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

export function DeleteUserModal({
  user,
  onClose,
  onDeleted,
}: {
  user: TeamUser;
  onClose: () => void;
  onDeleted: (message: string) => void;
}) {
  const [strategy, setStrategy] = useState<'transfer' | 'unassigned'>('transfer');
  const [transferTo, setTransferTo] = useState('');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [assignees, setAssignees] = useState<Option[]>([]);
  const [audits, setAudits] = useState<Audit[]>([]);
  const modalRef = useRef<HTMLElement>(null);

  useEffect(() => {
    apiRequest<Audit[]>(`/users/${user.id}/audits`).then(setAudits).catch(() => undefined);
    if (user.openAssignedCases > 0) {
      apiRequest<Option[]>('/users/assignable')
        .then(items => setAssignees(items.filter(item => item.id !== user.id)))
        .catch(() => undefined);
    }
    const focusable = () =>
      Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),select:not(:disabled),textarea:not(:disabled),input:not(:disabled),summary'
        ) ?? []
      ).filter(item => item.getClientRects().length > 0);
    requestAnimationFrame(() => focusable()[0]?.focus());
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
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

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmitDelete({ confirmed, openAssignedCases: user.openAssignedCases, strategy, transferToUserId: transferTo, saving })) {
      return;
    }
    setSaving(true);
    setError('');
    try {
      const body = {
        justification: reason.trim() || undefined,
        ...(user.openAssignedCases > 0
          ? {
              strategy,
              transferToUserId: strategy === 'transfer' ? transferTo : undefined,
              confirmUnassigned: strategy === 'unassigned',
            }
          : {}),
      };

      await apiRequest(`/users/${user.id}/delete`, {
        method: 'POST',
        body: JSON.stringify(body),
      });

      onDeleted('Usuário excluído com sucesso.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível excluir o usuário.');
    } finally {
      setSaving(false);
    }
  };

  const canDelete = canSubmitDelete({
    confirmed,
    openAssignedCases: user.openAssignedCases,
    strategy,
    transferToUserId: transferTo,
    saving,
  });

  return (
    <div
      className="overlay team-modal-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={modalRef}
        className="modal team-user-modal team-delete-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-user-title"
      >
        <header className="modal-head">
          <div>
            <h2 id="delete-user-title">Excluir usuário</h2>
            <p>{user.name} · {user.email}</p>
          </div>
          <button className="icon-btn" aria-label="Fechar exclusão do usuário" onClick={onClose}>
            <X />
          </button>
        </header>
        <form onSubmit={submit}>
          <div className="modal-body">
            <div className="team-delete-section">
              <div className="team-delete-warning">
                <AlertTriangle aria-hidden="true" />
                <div>
                  <strong>Atenção aos efeitos da exclusão:</strong>
                  <p>
                    A conta sai da Equipe e perde o acesso imediatamente. Quando houver histórico vinculado, casos e auditorias anteriores são preservados de forma íntegra e os dados pessoais são anonimizados.
                  </p>
                </div>
              </div>

              {user.openAssignedCases > 0 ? (
                <fieldset className="team-delete-cases-fieldset">
                  <legend>Destino de {user.openAssignedCases} caso(s) aberto(s)</legend>
                  <p className="team-delete-cases-hint">
                    Este usuário possui {user.openAssignedCases} caso(s) atribuído(s). Escolha o destino dos casos antes de confirmar a exclusão:
                  </p>
                  <label>
                    <input
                      type="radio"
                      name="caseStrategy"
                      checked={strategy === 'transfer'}
                      onChange={() => setStrategy('transfer')}
                    />
                    Transferir para outro responsável
                  </label>
                  {strategy === 'transfer' && (
                    <label>
                      Novo responsável
                      <select
                        required
                        value={transferTo}
                        onChange={event => setTransferTo(event.target.value)}
                      >
                        <option value="">Selecione um analista ou administrador</option>
                        {assignees.map(item => (
                          <option value={item.id} key={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label>
                    <input
                      type="radio"
                      name="caseStrategy"
                      checked={strategy === 'unassigned'}
                      onChange={() => setStrategy('unassigned')}
                    />
                    Deixar sem responsável
                  </label>
                </fieldset>
              ) : (
                <p className="team-delete-no-cases">Este usuário não possui casos abertos atribuídos no momento.</p>
              )}

              <label>
                Justificativa da exclusão (opcional)
                <textarea
                  maxLength={500}
                  value={reason}
                  onChange={event => setReason(event.target.value)}
                  placeholder="Informe o motivo da exclusão para registro na auditoria..."
                />
              </label>
            </div>

            <label className="team-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={event => setConfirmed(event.target.checked)}
              />
              Confirmo a exclusão desta conta: ela sairá da Equipe com perda imediata de acesso, preservando casos e auditorias anteriores quando houver histórico.
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
            <button
              type="submit"
              className="team-danger-btn"
              disabled={!canDelete}
            >
              {saving ? 'Excluindo...' : 'Excluir usuário'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export const UserManagementModal = EditUserModal;
