import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { AlertTriangle, FileText, LoaderCircle, PackagePlus, Paperclip, Plus, Trash2, X } from 'lucide-react';
import { apiRequest } from './api';
import type { OperationalIndicators } from './data';
import {
  ACCEPTED_FILE_TYPES, createEmptyItem, createEmptySacForm, hasUnsavedSacChanges, sacFormPayload,
  toLocalDateTimeInput, validateAttachments, validateSacForm, type SacFormErrors, type SacFormValues,
} from './sac-form';

type Option = { id: string; name: string; active?: boolean };
type CatalogList = { items: Option[] };
export type DetailedRecord = {
  id: string; ticket: string; orderNumber: string; externalTicket: string | null; description: string; internalNote: string | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'; openedAt: string; dueAt: string; updatedAt: string;
  identifiedCause: string | null; responsibleArea: string | null; correctiveAction: string | null;
  customer: Option; reason: Option; subreason: Option | null; channelCatalog: Option | null; assignee: Option | null;
  items: Array<{ id: string; code: string; description: string; batch: string | null; quantity: string; note: string | null }>;
  attachments: Array<{ id: string; originalName: string; mimeType: string; sizeBytes: number; status?: 'ACTIVE' | 'QUARANTINED' | 'PENDING_DELETION'; createdAt?: string; author?: { id: string; name: string } | null }>;
  operational: OperationalIndicators;
};

function toDateInput(value: string) {
  const date = new Date(value); const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fromRecord(record: DetailedRecord): SacFormValues {
  return {
    customerName: record.customer.name, orderNumber: record.orderNumber, externalTicket: record.externalTicket ?? '',
    channelId: record.channelCatalog?.id ?? '', openedAt: toLocalDateTimeInput(new Date(record.openedAt)), reasonId: record.reason.id,
    subreasonId: record.subreason?.id ?? '', priority: record.priority, description: record.description,
    internalNote: record.internalNote ?? '', assigneeId: record.assignee?.id ?? '', dueDate: toDateInput(record.dueAt),
    identifiedCause: record.identifiedCause ?? '', responsibleArea: record.responsibleArea ?? '', correctiveAction: record.correctiveAction ?? '',
    items: record.items.map(item => ({ key: item.id, code: item.code, description: item.description, batch: item.batch ?? '', quantity: String(item.quantity), note: item.note ?? '' })),
  };
}

function Confirm({ title, text, action, onCancel, onConfirm }: { title: string; text: string; action: string; onCancel: () => void; onConfirm: () => void }) {
  return <div className="overlay sac-confirm-layer"><section className="modal sac-confirm" role="alertdialog" aria-modal="true" aria-labelledby="sac-confirm-title"><header className="modal-head"><div><h2 id="sac-confirm-title">{title}</h2><p>{text}</p></div></header><footer className="form-footer"><button type="button" className="secondary" onClick={onCancel}>Continuar editando</button><button type="button" className="sac-danger-action" onClick={onConfirm}>{action}</button></footer></section></div>;
}

export function SacRecordForm({ recordId, onClose, onSaved, onOpenCatalogs }: { recordId?: string; onClose: () => void; onSaved: (record: DetailedRecord, created: boolean) => void; onOpenCatalogs: () => void }) {
  const [form, setForm] = useState<SacFormValues>(() => createEmptySacForm());
  const [initial, setInitial] = useState<SacFormValues>(() => createEmptySacForm());
  const [record, setRecord] = useState<DetailedRecord | null>(null);
  const [reasons, setReasons] = useState<Option[]>([]); const [subreasons, setSubreasons] = useState<Option[]>([]); const [channels, setChannels] = useState<Option[]>([]); const [assignees, setAssignees] = useState<Option[]>([]); const [customers, setCustomers] = useState<Option[]>([]);
  const [loading, setLoading] = useState(true); const [optionsError, setOptionsError] = useState(''); const [saving, setSaving] = useState(false); const [apiError, setApiError] = useState(''); const [errors, setErrors] = useState<SacFormErrors>({});
  const [files, setFiles] = useState<File[]>([]); const [fileError, setFileError] = useState(''); const [duplicateExternal, setDuplicateExternal] = useState(false); const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [discarding, setDiscarding] = useState(false); const [removingItem, setRemovingItem] = useState<number | null>(null);
  const modalRef = useRef<HTMLFormElement>(null); const firstFieldRef = useRef<HTMLInputElement>(null); const idempotencyKey = useRef(crypto.randomUUID());
  const dirty = useMemo(() => hasUnsavedSacChanges(form, initial, files), [form, initial, files]);
  const editing = Boolean(recordId);

  useEffect(() => {
    let active = true; setLoading(true); setOptionsError('');
    Promise.all([
      apiRequest<CatalogList>('/catalog/reasons?status=active&page=1&pageSize=100'),
      apiRequest<CatalogList>('/catalog/channels?status=active&page=1&pageSize=100'),
      apiRequest<Option[]>('/users/assignable'),
      recordId ? apiRequest<DetailedRecord>(`/sac-records/${recordId}`) : Promise.resolve(null),
    ]).then(([reasonResult, channelResult, userResult, detail]) => {
      if (!active) return;
      setReasons(detail && !reasonResult.items.some(option => option.id === detail.reason.id) ? [...reasonResult.items, detail.reason] : reasonResult.items);
      setChannels(detail?.channelCatalog && !channelResult.items.some(option => option.id === detail.channelCatalog?.id) ? [...channelResult.items, detail.channelCatalog] : channelResult.items);
      setAssignees(detail?.assignee && !userResult.some(option => option.id === detail.assignee?.id) ? [...userResult, detail.assignee] : userResult);
      if (detail) { const values = fromRecord(detail); setRecord(detail); setForm(values); setInitial(values); }
      else { const values = createEmptySacForm(); setForm(values); setInitial(values); }
    }).catch(error => { if (active) setOptionsError(error instanceof Error ? error.message : 'Não foi possível carregar o formulário.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [recordId]);

  useEffect(() => {
    if (!form.reasonId) { setSubreasons([]); return; }
    let active = true;
    apiRequest<CatalogList>(`/catalog/subreasons?status=active&page=1&pageSize=100&reasonId=${encodeURIComponent(form.reasonId)}`)
      .then(result => {
        if (!active) return;
        const historical = record?.subreason && record.reason.id === form.reasonId && !result.items.some(option => option.id === record.subreason?.id) ? [record.subreason] : [];
        setSubreasons([...result.items, ...historical]);
      }).catch(() => { if (active) { setSubreasons([]); setOptionsError('Não foi possível carregar os submotivos.'); } });
    return () => { active = false; };
  }, [form.reasonId, record]);

  useEffect(() => {
    if (form.customerName.trim().length < 2) { setCustomers([]); return; }
    const timer = setTimeout(() => apiRequest<Option[]>(`/sac-records/customer-options?query=${encodeURIComponent(form.customerName.trim())}`).then(setCustomers).catch(() => setCustomers([])), 250);
    return () => clearTimeout(timer);
  }, [form.customerName]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', beforeUnload); return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  const requestClose = () => dirty ? setDiscarding(true) : onClose();
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); if (discarding) setDiscarding(false); else if (removingItem !== null) setRemovingItem(null); else requestClose(); return; }
      if (event.key !== 'Tab' || !modalRef.current) return;
      const focusable = Array.from(modalRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')).filter(element => element.offsetParent !== null);
      if (!focusable.length) return; const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  });

  const change = <Key extends keyof SacFormValues>(key: Key, value: SacFormValues[Key]) => {
    setForm(current => ({ ...current, [key]: value, ...(key === 'reasonId' ? { subreasonId: '' } : {}) }));
    setErrors(current => ({ ...current, [key]: undefined }));
    if (key === 'externalTicket') { setDuplicateExternal(false); setAllowDuplicate(false); }
  };
  const changeItem = (index: number, key: keyof SacFormValues['items'][number], value: string) => setForm(current => ({ ...current, items: current.items.map((item, itemIndex) => itemIndex === index ? { ...item, [key]: value } : item) }));
  const removeItem = (index: number) => { setForm(current => ({ ...current, items: current.items.filter((_, itemIndex) => itemIndex !== index) })); setRemovingItem(null); };
  const requestRemoveItem = (index: number) => {
    const item = form.items[index]; if ([item.code, item.description, item.batch, item.quantity, item.note].some(Boolean)) setRemovingItem(index); else removeItem(index);
  };
  const checkExternal = async () => {
    if (!form.externalTicket.trim()) return;
    try { const result = await apiRequest<{ duplicate: boolean }>(`/sac-records/external-ticket-check?value=${encodeURIComponent(form.externalTicket.trim())}${recordId ? `&excludeId=${encodeURIComponent(recordId)}` : ''}`); setDuplicateExternal(result.duplicate); }
    catch { /* The backend repeats this check during save. */ }
  };
  const addFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = [...files, ...Array.from(event.target.files ?? [])]; const issue = validateAttachments(selected, record?.attachments.length ?? 0);
    if (issue) setFileError(issue); else { setFiles(selected); setFileError(''); }
    event.target.value = '';
  };
  const focusFirstError = (nextErrors: SacFormErrors) => requestAnimationFrame(() => {
    const key = Object.keys(nextErrors)[0]; if (key) modalRef.current?.querySelector<HTMLElement>(`[data-field="${key}"]`)?.focus();
  });
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (saving) return;
    const nextErrors = validateSacForm(form);
    if (duplicateExternal && !allowDuplicate) nextErrors.externalTicket = 'Confirme a possível duplicidade antes de continuar.';
    if (!reasons.length) nextErrors.reasonId = 'Cadastre pelo menos um motivo antes de criar um registro.';
    if (!channels.length) nextErrors.channelId = 'Cadastre pelo menos um canal antes de criar um registro.';
    setErrors(nextErrors); setApiError(''); if (Object.keys(nextErrors).length) { focusFirstError(nextErrors); return; }
    setSaving(true);
    try {
      const payload = sacFormPayload(form, allowDuplicate, record?.updatedAt);
      const body = new FormData(); body.append('payload', JSON.stringify(payload)); files.forEach(file => body.append('files', file));
      const saved = await apiRequest<DetailedRecord>(recordId ? `/sac-records/${recordId}` : '/sac-records', { method: recordId ? 'PATCH' : 'POST', body, headers: recordId ? {} : { 'Idempotency-Key': idempotencyKey.current } });
      onSaved(saved, !recordId);
    } catch (error) { setApiError(error instanceof Error ? error.message : 'Não foi possível salvar o registro.'); }
    finally { setSaving(false); }
  };

  return <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget) requestClose(); }}><form ref={modalRef} className="modal sac-form-modal" onSubmit={submit} aria-labelledby="sac-form-title"><header className="modal-head"><div><h2 id="sac-form-title">{editing ? `Editar ${record?.ticket ?? 'registro'}` : 'Novo registro'}</h2><p>{editing ? 'O código interno é imutável.' : 'O código interno será gerado com segurança ao salvar.'}</p></div><button type="button" className="icon-btn" onClick={requestClose} aria-label="Fechar formulário"><X /></button></header>
    {loading ? <div className="sac-form-loading" role="status"><LoaderCircle />Carregando formulário...</div> : optionsError && !reasons.length && !channels.length ? <div className="list-error"><AlertTriangle /><div><strong>Não foi possível preparar o formulário</strong><span>{optionsError}</span></div></div> : <div className="sac-form-scroll">
      {(!reasons.length || !channels.length) && <section className="sac-catalog-warning" role="alert"><AlertTriangle /><div><strong>Cadastros necessários</strong><p>{!reasons.length && 'Cadastre pelo menos um motivo antes de criar um registro. '}{!channels.length && 'Cadastre pelo menos um canal antes de criar um registro.'}</p></div><button type="button" className="secondary" onClick={onOpenCatalogs}>Abrir Cadastros</button></section>}
      <fieldset><legend>1. Identificação</legend><div className="sac-form-grid"><label>Cliente *<input ref={firstFieldRef} data-field="customerName" list="customer-options" value={form.customerName} maxLength={160} onChange={event => change('customerName', event.target.value)} aria-invalid={Boolean(errors.customerName)} /><datalist id="customer-options">{customers.map(customer => <option value={customer.name} key={customer.id} />)}</datalist>{errors.customerName && <small>{errors.customerName}</small>}<em>Pesquise um cliente existente ou informe um nome para cadastro mínimo.</em></label><label>Número do pedido *<input data-field="orderNumber" value={form.orderNumber} maxLength={40} onChange={event => change('orderNumber', event.target.value)} aria-invalid={Boolean(errors.orderNumber)} />{errors.orderNumber && <small>{errors.orderNumber}</small>}</label><label>Ticket ou protocolo externo<input data-field="externalTicket" value={form.externalTicket} maxLength={80} onBlur={checkExternal} onChange={event => change('externalTicket', event.target.value)} aria-invalid={Boolean(errors.externalTicket)} />{errors.externalTicket && <small>{errors.externalTicket}</small>}{duplicateExternal && <span className="sac-duplicate-warning"><span>Possível duplicidade encontrada.</span><span className="sac-duplicate-confirm"><input type="checkbox" aria-label="Confirmar possível duplicidade" checked={allowDuplicate} onChange={event => setAllowDuplicate(event.target.checked)} />Confirmo que desejo continuar.</span></span>}</label><label>Canal *<select data-field="channelId" value={form.channelId} onChange={event => change('channelId', event.target.value)} aria-invalid={Boolean(errors.channelId)}><option value="">Selecione conscientemente</option>{channels.map(channel => <option value={channel.id} key={channel.id}>{channel.name}</option>)}</select>{errors.channelId && <small>{errors.channelId}</small>}</label><label>Data de abertura *<input data-field="openedAt" type="datetime-local" value={form.openedAt} onChange={event => change('openedAt', event.target.value)} aria-invalid={Boolean(errors.openedAt)} />{errors.openedAt && <small>{errors.openedAt}</small>}</label>{editing && <label>Código interno<input value={record?.ticket ?? ''} disabled /></label>}</div></fieldset>
      <fieldset><legend>2. Classificação da ocorrência</legend><div className="sac-form-grid"><label>Motivo *<select data-field="reasonId" value={form.reasonId} onChange={event => change('reasonId', event.target.value)} aria-invalid={Boolean(errors.reasonId)}><option value="">Selecione</option>{reasons.map(reason => <option value={reason.id} key={reason.id}>{reason.name}</option>)}</select>{errors.reasonId && <small>{errors.reasonId}</small>}</label><label>Submotivo<select value={form.subreasonId} onChange={event => change('subreasonId', event.target.value)} disabled={!form.reasonId}><option value="">Sem submotivo</option>{subreasons.map(subreason => <option value={subreason.id} key={subreason.id}>{subreason.name}</option>)}</select></label><label>Prioridade *<select data-field="priority" value={form.priority} disabled={editing} onChange={event => change('priority', event.target.value as SacFormValues['priority'])} aria-invalid={Boolean(errors.priority)}><option value="">Selecione conscientemente</option><option value="LOW">Baixa</option><option value="MEDIUM">Média</option><option value="HIGH">Alta</option><option value="CRITICAL">Crítica</option></select>{errors.priority && <small>{errors.priority}</small>}{editing && <em>Altere pela ação operacional do caso.</em>}</label></div></fieldset>
      <fieldset><legend>3. Descrição</legend><div className="sac-form-grid"><label className="full">Descrição completa *<textarea data-field="description" value={form.description} maxLength={5000} onChange={event => change('description', event.target.value)} aria-invalid={Boolean(errors.description)} />{errors.description && <small>{errors.description}</small>}</label><label className="full">Observação interna<textarea value={form.internalNote} maxLength={2000} onChange={event => change('internalNote', event.target.value)} /></label></div></fieldset>
      <fieldset><legend>4. Atribuição e prazo</legend><div className="sac-form-grid"><label>Responsável<select value={form.assigneeId} disabled={editing} onChange={event => change('assigneeId', event.target.value)}><option value="">Sem responsável</option>{assignees.map(user => <option value={user.id} key={user.id}>{user.name}</option>)}</select>{editing && <em>Altere pela ação operacional do caso.</em>}</label><label>Prazo de resolução *<input data-field="dueDate" type="date" value={form.dueDate} disabled={editing} onChange={event => change('dueDate', event.target.value)} aria-invalid={Boolean(errors.dueDate)} />{errors.dueDate && <small>{errors.dueDate}</small>}<em>{editing ? 'Altere pela ação operacional do caso.' : 'O prazo representa o fim do dia selecionado.'}</em></label></div></fieldset>
      <fieldset><legend>5. Itens envolvidos</legend><div className="sac-section-heading"><p>Opcional. Adicione somente produtos relacionados à ocorrência.</p><button type="button" className="secondary" onClick={() => change('items', [...form.items, createEmptyItem()])}><PackagePlus />Adicionar item</button></div><div className="sac-items">{form.items.map((item, index) => <article key={item.key}><header><strong>Item {index + 1}</strong><button type="button" className="icon-btn" aria-label={`Remover item ${index + 1}`} onClick={() => requestRemoveItem(index)}><Trash2 /></button></header><div className="sac-form-grid"><label>Código ou SKU *<input data-field={`item-${index}`} value={item.code} maxLength={80} onChange={event => changeItem(index, 'code', event.target.value)} /></label><label>Descrição *<input value={item.description} maxLength={300} onChange={event => changeItem(index, 'description', event.target.value)} /></label><label>Lote<input value={item.batch} maxLength={80} onChange={event => changeItem(index, 'batch', event.target.value)} /></label><label>Quantidade reclamada *<input type="number" min="0.001" step="0.001" value={item.quantity} onChange={event => changeItem(index, 'quantity', event.target.value)} /></label><label className="full">Observação<input value={item.note} maxLength={500} onChange={event => changeItem(index, 'note', event.target.value)} /></label>{errors[`item-${index}`] && <small className="full">{errors[`item-${index}`]}</small>}</div></article>)}</div></fieldset>
      <fieldset><legend>6. Evidências ({files.length + (record?.attachments.length ?? 0)}/5)</legend><label className="sac-upload"><Paperclip /><span><strong>Selecionar evidências</strong><small>PDF, JPG, JPEG ou PNG · até 5 arquivos · 10 MB por arquivo</small></span><input type="file" accept={ACCEPTED_FILE_TYPES.join(',')} multiple onChange={addFiles} disabled={saving} /></label>{fileError && <p className="sac-field-error" role="alert">{fileError}</p>}<div className="sac-files">{record?.attachments.map(file => <article key={file.id}><FileText /><span><strong>{file.originalName}</strong><small>{file.mimeType} · {(file.sizeBytes / 1024).toFixed(1)} KB · já salvo</small></span></article>)}{files.map((file, index) => <article key={`${file.name}-${index}`}><FileText /><span><strong>{file.name}</strong><small>{file.type || 'arquivo'} · {(file.size / 1024).toFixed(1)} KB · pronto para envio</small></span><button type="button" className="icon-btn" aria-label={`Remover ${file.name}`} onClick={() => setFiles(current => current.filter((_, fileIndex) => fileIndex !== index))} disabled={saving}><X /></button></article>)}</div></fieldset>
      <fieldset><legend>7. Análise interna</legend><div className="sac-form-grid"><label className="full">Causa identificada<textarea value={form.identifiedCause} maxLength={2000} onChange={event => change('identifiedCause', event.target.value)} /></label><label>Área responsável<input value={form.responsibleArea} maxLength={160} onChange={event => change('responsibleArea', event.target.value)} /></label><label className="full">Ação corretiva<textarea value={form.correctiveAction} maxLength={2000} onChange={event => change('correctiveAction', event.target.value)} /></label></div></fieldset>
      {optionsError && <p className="sac-form-api-error" role="alert">{optionsError}</p>}{apiError && <p className="sac-form-api-error" role="alert">{apiError}</p>}
    </div>}
    <footer className="form-footer"><button type="button" className="secondary" onClick={requestClose} disabled={saving}>Cancelar</button><button type="submit" className="primary" disabled={saving || loading}>{saving ? <><LoaderCircle className="spin" />{editing ? 'Salvando...' : 'Criando...'}</> : editing ? 'Salvar alterações' : 'Criar registro'}</button></footer></form>
    {discarding && <Confirm title="Descartar alterações?" text="Os dados preenchidos e arquivos selecionados não serão salvos." action="Descartar" onCancel={() => setDiscarding(false)} onConfirm={onClose} />}
    {removingItem !== null && <Confirm title="Remover item?" text="As informações preenchidas neste item serão descartadas." action="Remover item" onCancel={() => setRemovingItem(null)} onConfirm={() => removeItem(removingItem)} />}
  </div>;
}
