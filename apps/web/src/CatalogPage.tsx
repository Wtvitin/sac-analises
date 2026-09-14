import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Pencil, Plus, RefreshCw, Search, Settings2, X } from 'lucide-react';
import { apiRequest } from './api';
import {
  catalogConfig, catalogListPath, isCatalogFormDirty, validateCatalogForm,
  type CatalogForm, type CatalogItem, type CatalogStatus, type CatalogTab,
} from './catalog';

type CatalogList = { items: CatalogItem[]; total: number; page: number; pageSize: number };
const blankForm: CatalogForm = { name: '', description: '', active: true, displayOrder: '0', reasonId: '' };

function formatUpdatedAt(value: string) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

function CatalogBadge({ active }: { active: boolean }) {
  return <span className={`catalog-badge ${active ? 'is-active' : 'is-inactive'}`}><i aria-hidden="true" />{active ? 'Ativo' : 'Inativo'}</span>;
}

function CatalogLoading() {
  return <div className="catalog-loading" aria-label="Carregando cadastros">{Array.from({ length: 5 }, (_, index) => <i key={index} />)}</div>;
}

function CatalogPagination({ total, page, pageSize, onPage, onPageSize }: { total: number; page: number; pageSize: number; onPage: (page: number) => void; onPageSize: (size: number) => void }) {
  if (!total) return null;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return <footer className="pagination"><span>{total} {total === 1 ? 'resultado' : 'resultados'}</span><label>Por página<select value={pageSize} onChange={event => onPageSize(Number(event.target.value))}>{[10, 20, 50, 100].map(value => <option key={value}>{value}</option>)}</select></label>{pages > 1 && <nav aria-label="Paginação dos cadastros"><button type="button" disabled={page === 1} onClick={() => onPage(page - 1)} aria-label="Página anterior"><ChevronLeft /></button><span>Página {page} de {pages}</span><button type="button" disabled={page === pages} onClick={() => onPage(page + 1)} aria-label="Próxima página"><ChevronRight /></button></nav>}</footer>;
}

function ConfirmDialog({ title, text, confirmLabel, danger = false, busy = false, onCancel, onConfirm }: { title: string; text: string; confirmLabel: string; danger?: boolean; busy?: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <div className="overlay catalog-confirm-layer" role="presentation"><section className="modal catalog-confirm" role="alertdialog" aria-modal="true" aria-labelledby="catalog-confirm-title"><header className="modal-head"><div><h2 id="catalog-confirm-title">{title}</h2><p>{text}</p></div></header><footer className="form-footer"><button type="button" className="secondary" onClick={onCancel} disabled={busy}>Cancelar</button><button type="button" className={danger ? 'catalog-warning-action' : 'primary'} onClick={onConfirm} disabled={busy}>{busy ? 'Processando...' : confirmLabel}</button></footer></section></div>;
}

function CatalogModal({ tab, item, reasons, onClose, onSaved }: { tab: CatalogTab; item: CatalogItem | null; reasons: CatalogItem[]; onClose: () => void; onSaved: (message: string) => void }) {
  const config = catalogConfig[tab];
  const initial = useRef<CatalogForm>({ ...blankForm, ...(item ? { name: item.name, description: item.description ?? '', active: item.active, displayOrder: String(item.displayOrder), reasonId: item.reasonId ?? '' } : {}) });
  const [form, setForm] = useState(initial.current);
  const [errors, setErrors] = useState<Partial<Record<keyof CatalogForm, string>>>({});
  const [apiError, setApiError] = useState('');
  const [saving, setSaving] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const requestClose = () => isCatalogFormDirty(form, initial.current) ? setDiscarding(true) : onClose();
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') discarding ? setDiscarding(false) : requestClose(); };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  });
  const change = <Key extends keyof CatalogForm>(key: Key, value: CatalogForm[Key]) => { setForm(current => ({ ...current, [key]: value })); setErrors(current => ({ ...current, [key]: undefined })); };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (saving) return;
    const nextErrors = validateCatalogForm(tab, form); setErrors(nextErrors); setApiError('');
    if (Object.keys(nextErrors).length) return;
    setSaving(true);
    try {
      const body = { name: form.name, description: form.description, active: form.active, displayOrder: Number(form.displayOrder), ...(tab === 'subreasons' ? { reasonId: form.reasonId } : {}) };
      await apiRequest(item ? `${config.endpoint}/${item.id}` : config.endpoint, { method: item ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      onSaved(`${config.singular[0].toUpperCase()}${config.singular.slice(1)} ${item ? 'atualizado' : 'cadastrado'} com sucesso.`);
    } catch (error) { setApiError(error instanceof Error ? error.message : 'Não foi possível salvar o cadastro.'); }
    finally { setSaving(false); }
  };
  return <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget) requestClose(); }}><form className="modal catalog-modal" onSubmit={submit} aria-labelledby="catalog-modal-title"><header className="modal-head"><div><h2 id="catalog-modal-title">{item ? 'Editar' : 'Novo'} {config.singular}</h2><p>Os campos com * são obrigatórios.</p></div><button ref={closeButtonRef} type="button" className="icon-btn" aria-label="Fechar formulário" onClick={requestClose}><X /></button></header><div className="catalog-form-grid">
    {tab === 'subreasons' && <label>Motivo principal *<select autoFocus value={form.reasonId} onChange={event => change('reasonId', event.target.value)} aria-invalid={Boolean(errors.reasonId)}><option value="">Selecione</option>{reasons.map(reason => <option key={reason.id} value={reason.id} disabled={!reason.active && reason.id !== item?.reasonId}>{reason.name}{!reason.active ? ' — inativo' : ''}</option>)}</select>{errors.reasonId && <small>{errors.reasonId}</small>}</label>}
    <label>Nome *<input autoFocus={tab !== 'subreasons'} value={form.name} maxLength={120} onChange={event => change('name', event.target.value)} aria-invalid={Boolean(errors.name)} />{errors.name && <small>{errors.name}</small>}</label>
    <label>Descrição<textarea value={form.description} maxLength={500} onChange={event => change('description', event.target.value)} />{errors.description && <small>{errors.description}</small>}</label>
    <div className="catalog-form-row"><label>Estado<select value={form.active ? 'active' : 'inactive'} onChange={event => change('active', event.target.value === 'active')}><option value="active">Ativo</option><option value="inactive">Inativo</option></select></label><label>Ordem *<input type="number" min="0" max="9999" value={form.displayOrder} onChange={event => change('displayOrder', event.target.value)} aria-invalid={Boolean(errors.displayOrder)} />{errors.displayOrder && <small>{errors.displayOrder}</small>}</label></div>
    {apiError && <p className="catalog-form-error" role="alert">{apiError}</p>}
  </div><footer className="form-footer"><button type="button" className="secondary" onClick={requestClose} disabled={saving}>Cancelar</button><button type="submit" className="primary" disabled={saving}>{saving ? 'Salvando...' : 'Salvar cadastro'}</button></footer></form>{discarding && <ConfirmDialog title="Descartar alterações?" text="As informações não salvas serão perdidas." confirmLabel="Descartar" danger onCancel={() => { setDiscarding(false); closeButtonRef.current?.focus(); }} onConfirm={onClose} />}</div>;
}

export function CatalogPage({ onSuccess }: { onSuccess: (message: string) => void }) {
  const [tab, setTab] = useState<CatalogTab>('reasons');
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [reasons, setReasons] = useState<CatalogItem[]>([]);
  const [queryInput, setQueryInput] = useState(''); const [query, setQuery] = useState('');
  const [status, setStatus] = useState<CatalogStatus>('all'); const [reasonId, setReasonId] = useState('');
  const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(20); const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<CatalogItem | null | undefined>(); const [statusItem, setStatusItem] = useState<CatalogItem | null>(null); const [statusBusy, setStatusBusy] = useState(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const config = catalogConfig[tab];
  useEffect(() => { const timer = setTimeout(() => setQuery(queryInput), 300); return () => clearTimeout(timer); }, [queryInput]);
  useEffect(() => { setPage(1); }, [tab, query, status, reasonId, pageSize]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    apiRequest<CatalogList>(catalogListPath(tab, query, status, page, pageSize, reasonId), { signal: controller.signal })
      .then(result => { setItems(result.items); setTotal(result.total); })
      .catch(issue => { if ((issue as Error).name !== 'AbortError') setError(issue instanceof Error ? issue.message : 'Não foi possível carregar os cadastros.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [tab, query, status, page, pageSize, reasonId, reload]);
  useEffect(() => {
    if (tab !== 'subreasons' && editing === undefined) return;
    apiRequest<CatalogList>('/catalog/reasons?status=all&page=1&pageSize=100').then(result => setReasons(result.items)).catch(() => setReasons([]));
  }, [tab, editing, reload]);
  const openForm = (item: CatalogItem | null) => { openerRef.current = document.activeElement as HTMLElement; setEditing(item); };
  const closeForm = () => { setEditing(undefined); requestAnimationFrame(() => openerRef.current?.focus()); };
  const saved = (message: string) => { closeForm(); setReload(value => value + 1); onSuccess(message); };
  const changeStatus = async () => {
    if (!statusItem || statusBusy) return; setStatusBusy(true);
    try { await apiRequest(`${config.endpoint}/${statusItem.id}/status`, { method: 'PATCH', body: JSON.stringify({ active: !statusItem.active }) }); setStatusItem(null); setReload(value => value + 1); onSuccess(`${config.singular[0].toUpperCase()}${config.singular.slice(1)} ${statusItem.active ? 'inativado' : 'ativado'} com sucesso.`); }
    catch (issue) { setError(issue instanceof Error ? issue.message : 'Não foi possível alterar o estado.'); setStatusItem(null); }
    finally { setStatusBusy(false); }
  };
  const switchTab = (next: CatalogTab) => { setTab(next); setQueryInput(''); setQuery(''); setStatus('all'); setReasonId(''); setPage(1); };
  const filtered = Boolean(query || status !== 'all' || reasonId);
  return <><header className="page-header page-title page-title-row"><div className="page-header-copy"><h1>Cadastros</h1><p>Mantenha as classificações padronizadas para análises confiáveis.</p></div><div className="page-header-actions"><button className="primary" onClick={() => openForm(null)}><Plus />Novo cadastro</button></div></header>
    <section className="settings-layout"><nav className="settings-nav catalog-tabs" aria-label="Categorias de cadastros">{(Object.keys(catalogConfig) as CatalogTab[]).map(value => <button className={tab === value ? 'active' : ''} aria-current={tab === value ? 'page' : undefined} onClick={() => switchTab(value)} key={value}>{catalogConfig[value].label}<ChevronRight /></button>)}</nav>
      <section className="table-card settings-content records-surface"><div className="catalog-heading"><div><h2>{config.label}</h2><p>{config.description}</p></div><button className="primary catalog-inline-new" onClick={() => openForm(null)}><Plus />Novo cadastro</button></div><div className="catalog-toolbar"><div className="search-input table-search"><Search /><input value={queryInput} onChange={event => setQueryInput(event.target.value)} placeholder={`Buscar em ${config.label.toLowerCase()}...`} aria-label={`Buscar em ${config.label.toLowerCase()}`} />{queryInput && <button type="button" className="search-clear" aria-label="Limpar busca" onClick={() => setQueryInput('')}><X /></button>}</div><label>Estado<select value={status} onChange={event => setStatus(event.target.value as CatalogStatus)}><option value="all">Todos</option><option value="active">Ativos</option><option value="inactive">Inativos</option></select></label>{tab === 'subreasons' && <label>Motivo<select value={reasonId} onChange={event => setReasonId(event.target.value)}><option value="">Todos os motivos</option>{reasons.map(reason => <option key={reason.id} value={reason.id}>{reason.name}</option>)}</select></label>}<span>{total} {total === 1 ? 'resultado' : 'resultados'}</span></div>
        {loading ? <CatalogLoading /> : error ? <div className="list-error"><AlertTriangle /><div><strong>Não foi possível carregar os cadastros</strong><span>{error}</span></div><button className="secondary" onClick={() => setReload(value => value + 1)}><RefreshCw />Tentar novamente</button></div> : !items.length ? <div className="empty-state empty-state-compact"><Settings2 /><strong>{filtered ? 'Nenhum resultado encontrado' : config.emptyTitle}</strong><span>{filtered ? 'Tente ajustar a busca ou os filtros.' : config.emptyText}</span><div className="empty-state-actions">{filtered ? <button className="secondary" onClick={() => { setQueryInput(''); setStatus('all'); setReasonId(''); }}>Limpar filtros</button> : <button className="primary" onClick={() => openForm(null)}><Plus />{config.emptyAction}</button>}</div></div> : <><div className="catalog-table-wrap"><table className="catalog-table"><thead><tr><th>Nome</th>{tab === 'subreasons' && <th>Motivo principal</th>}<th>Descrição</th><th>Estado</th><th>Ordem</th><th>Última atualização</th><th>Ações</th></tr></thead><tbody>{items.map(item => <tr key={item.id}><td><strong>{item.name}</strong></td>{tab === 'subreasons' && <td>{item.reason?.name}</td>}<td><span className="catalog-description">{item.description || 'Sem descrição'}</span></td><td><CatalogBadge active={item.active} /></td><td>{item.displayOrder}</td><td><time>{formatUpdatedAt(item.updatedAt)}</time></td><td><div className="catalog-actions"><button type="button" onClick={() => openForm(item)}><Pencil />Editar</button><button type="button" onClick={() => setStatusItem(item)}>{item.active ? 'Inativar' : 'Ativar'}</button></div></td></tr>)}</tbody></table></div><div className="catalog-cards">{items.map(item => <article key={item.id}><header><strong>{item.name}</strong><CatalogBadge active={item.active} /></header>{tab === 'subreasons' && <p><b>Motivo:</b> {item.reason?.name}</p>}<p>{item.description || 'Sem descrição'}</p><dl><div><dt>Ordem</dt><dd>{item.displayOrder}</dd></div><div><dt>Atualização</dt><dd>{formatUpdatedAt(item.updatedAt)}</dd></div></dl><footer className="catalog-actions"><button type="button" onClick={() => openForm(item)}><Pencil />Editar</button><button type="button" onClick={() => setStatusItem(item)}>{item.active ? 'Inativar' : 'Ativar'}</button></footer></article>)}</div><CatalogPagination total={total} page={page} pageSize={pageSize} onPage={setPage} onPageSize={setPageSize} /></>}
      </section></section>
    {editing !== undefined && <CatalogModal key={`${tab}-${editing?.id ?? 'new'}`} tab={tab} item={editing} reasons={reasons} onClose={closeForm} onSaved={saved} />}
    {statusItem && <ConfirmDialog title={`${statusItem.active ? 'Inativar' : 'Ativar'} ${config.singular}?`} text={statusItem.active ? `${statusItem._count?.subreasons ? `Este motivo possui ${statusItem._count.subreasons} submotivo(s) ativo(s). ` : ''}Este cadastro deixará de aparecer em novos registros, mas continuará visível nos casos existentes.` : 'O cadastro voltará a ficar disponível para novas seleções.'} confirmLabel={statusItem.active ? 'Inativar' : 'Ativar'} danger={statusItem.active} busy={statusBusy} onCancel={() => setStatusItem(null)} onConfirm={changeStatus} />}
  </>;
}
