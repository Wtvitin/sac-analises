import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  AlertCircle, AlertTriangle, Check, Copy, Eye, FileCheck, FileText, HelpCircle, Info, LoaderCircle,
  Lock, PackagePlus, Paperclip, PenTool, Plus, ShieldAlert, Trash2, UploadCloud, X,
} from 'lucide-react';
import { apiRequest, type AuthUser } from './api';
import type { OperationalIndicators } from './data';
import {
  ACCEPTED_FILE_TYPES, createEmptyItem, createEmptyReference, createEmptySacForm, hasUnsavedSacChanges,
  SAC_REFERENCE_LABELS, sacFormPayload, toLocalDateTimeInput, validateAttachments, validateSacForm,
  type SacFormErrors, type SacFormValues, type SacReferenceForm, type SacReferenceType,
} from './sac-form';
import { DocumentImportDropzone } from './DocumentImportDropzone';
import './document-import.css';

type Option = { id: string; name: string; active?: boolean };
type CatalogList = { items: Option[] };
export type DetailedRecord = {
  id: string; ticket: string; orderNumber: string | null; externalTicket: string | null; description: string; internalNote: string | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'; openedAt: string; dueAt: string; updatedAt: string;
  identifiedCause: string | null; responsibleArea: string | null; correctiveAction: string | null;
  customer: Option & { document?: string | null; isDocumentMasked?: boolean };
  reason: Option; subreason: Option | null; channelCatalog: Option | null; assignee: Option | null;
  references?: Array<{ id: string; type: SacReferenceType; value: string; note: string | null }>;
  items: Array<{ id: string; code: string; description: string; batch: string | null; quantity: string; note: string | null }>;
  attachments: Array<{ id: string; originalName: string; mimeType: string; sizeBytes: number; status?: 'ACTIVE' | 'QUARANTINED' | 'PENDING_DELETION'; createdAt?: string; author?: { id: string; name: string } | null }>;
  operational: OperationalIndicators;
};

function ConfidenceTag({ field }: { field?: { confidence?: string; confidenceLevel?: string; sourceSnippet?: string; warning?: string; note?: string } | null }) {
  if (!field || !field.confidence) return null;
  const isHigh = field.confidenceLevel === 'HIGH' || field.confidence === 'IDENTIFIED';
  const isMedium = field.confidenceLevel === 'MEDIUM' || field.confidence === 'REVIEW_REQUIRED';

  if (isHigh) {
    return (
      <span className="sac-confidence-badge sac-confidence-badge--identified" title={`Confiança Alta. Origem: "${field.sourceSnippet || ''}"`}>
        <Check style={{ width: 12, height: 12 }} /> Alta
      </span>
    );
  }
  if (isMedium) {
    return (
      <span className="sac-confidence-badge sac-confidence-badge--review" title={field.warning || field.note || `Revisão recomendada. Origem: "${field.sourceSnippet || ''}"`}>
        <AlertCircle style={{ width: 12, height: 12 }} /> Média
      </span>
    );
  }
  return (
    <span className="sac-confidence-badge sac-confidence-badge--unknown" title={field.warning || 'Campo não localizado no documento.'}>
      <HelpCircle style={{ width: 12, height: 12 }} /> Baixa
    </span>
  );
}

function SnippetHint({ field }: { field?: { sourceSnippet?: string; warning?: string; note?: string } | null }) {
  if (!field || (!field.sourceSnippet && !field.warning && !field.note)) return null;
  return (
    <>
      {field.sourceSnippet && <span className="sac-field-snippet" title={field.sourceSnippet}>Origem: &ldquo;{field.sourceSnippet}&rdquo;</span>}
      {(field.warning || field.note) && (
        <span className="sac-field-snippet" style={{ color: 'var(--color-warning)' }}>
          {field.warning || field.note}
        </span>
      )}
    </>
  );
}

function toDateInput(value: string) {
  const date = new Date(value); const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fromRecord(record: DetailedRecord): SacFormValues {
  const references: SacReferenceForm[] = [];
  if (Array.isArray(record.references) && record.references.length > 0) {
    for (const r of record.references) {
      references.push({ key: r.id, type: r.type, value: r.value, note: r.note ?? '' });
    }
  } else {
    if (record.orderNumber) {
      references.push({ key: crypto.randomUUID(), type: 'ORDER', value: record.orderNumber, note: '' });
    }
    if (record.externalTicket) {
      references.push({ key: crypto.randomUUID(), type: 'ATTENDANCE', value: record.externalTicket, note: '' });
    }
  }

  return {
    customerName: record.customer.name, orderNumber: record.orderNumber ?? '', externalTicket: record.externalTicket ?? '',
    references,
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

export function SacRecordForm({
  recordId,
  currentUser,
  onClose,
  onSaved,
  onOpenCatalogs,
}: {
  recordId?: string;
  currentUser?: AuthUser;
  onClose: () => void;
  onSaved: (record: DetailedRecord, created: boolean) => void;
  onOpenCatalogs: () => void;
}) {
  const isAdmin = currentUser?.role === 'ADMIN';
  const [form, setForm] = useState<SacFormValues>(() => createEmptySacForm());
  const [initial, setInitial] = useState<SacFormValues>(() => createEmptySacForm());
  const [record, setRecord] = useState<DetailedRecord | null>(null);
  const [reasons, setReasons] = useState<Option[]>([]); const [subreasons, setSubreasons] = useState<Option[]>([]); const [channels, setChannels] = useState<Option[]>([]); const [assignees, setAssignees] = useState<Option[]>([]); const [customers, setCustomers] = useState<Option[]>([]);
  const [loading, setLoading] = useState(true); const [optionsError, setOptionsError] = useState(''); const [saving, setSaving] = useState(false); const [apiError, setApiError] = useState(''); const [errors, setErrors] = useState<SacFormErrors>({});
  const [files, setFiles] = useState<File[]>([]); const [fileError, setFileError] = useState(''); const [duplicateExternal, setDuplicateExternal] = useState(false); const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [discarding, setDiscarding] = useState(false); const [removingItem, setRemovingItem] = useState<number | null>(null);

  // Document Import state
  const [entryMode, setEntryMode] = useState<'manual' | 'import'>('manual');
  const [importSessionId, setImportSessionId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importedFile, setImportedFile] = useState<{ name: string; format: string } | null>(null);
  const [extractedData, setExtractedData] = useState<any | null>(null);
  const [preserveImportAsAttachment, setPreserveImportAsAttachment] = useState(true);
  const [copySensitiveConfirm, setCopySensitiveConfirm] = useState(false);
  const [revealingIndex, setRevealingIndex] = useState<number | null>(null);

  const modalRef = useRef<HTMLFormElement>(null); const firstFieldRef = useRef<HTMLInputElement>(null); const idempotencyKey = useRef(crypto.randomUUID());
  const dirty = useMemo(() => Boolean(importSessionId) || hasUnsavedSacChanges(form, initial, files), [importSessionId, form, initial, files]);
  const editing = Boolean(recordId);

  const addReference = () => {
    setForm(curr => ({
      ...curr,
      references: [...curr.references, createEmptyReference()],
    }));
  };

  const removeReference = (index: number) => {
    setForm(curr => ({
      ...curr,
      references: curr.references.filter((_, i) => i !== index),
    }));
  };

  const updateReference = (index: number, patch: Partial<SacReferenceForm>) => {
    setForm(curr => {
      const updated = [...curr.references];
      if (updated[index]) {
        updated[index] = { ...updated[index], ...patch };
      }
      return { ...curr, references: updated };
    });
  };

  const handleRevealImportField = async (index: number) => {
    if (!importSessionId || !isAdmin) return;
    setRevealingIndex(index);
    try {
      const res = await apiRequest<{ revealedValue: string; category: string }>(
        `/document-imports/${importSessionId}/reveal`,
        {
          method: 'POST',
          body: JSON.stringify({ index }),
        }
      );
      if (res && res.revealedValue) {
        setExtractedData((prev: any) => {
          if (!prev || !Array.isArray(prev.additionalInfo)) return prev;
          const updated = [...prev.additionalInfo];
          if (updated[index]) {
            updated[index] = {
              ...updated[index],
              value: res.revealedValue,
              isMasked: false,
            };
          }
          return { ...prev, additionalInfo: updated };
        });
      }
    } catch (err: any) {
      alert(err.message || 'Não foi possível revelar o dado sensível.');
    } finally {
      setRevealingIndex(null);
    }
  };

  const executeCopyAdditionalInfo = (includeSensitive: boolean) => {
    if (!extractedData?.additionalInfo || extractedData.additionalInfo.length === 0) return;
    const itemsToCopy = extractedData.additionalInfo.filter((info: any) => {
      if (includeSensitive) return true;
      return info.category !== 'SENSITIVE' && !info.isSensitive;
    });

    if (itemsToCopy.length === 0) {
      alert('Nenhum campo para copiar (campos sensíveis foram excluídos).');
      return;
    }

    const lines = itemsToCopy.map((info: any) => `${info.label}: ${info.value}`);
    const textToAppend = `[Informações extraídas do documento]\n${lines.join('\n')}`;
    setForm(curr => ({
      ...curr,
      internalNote: curr.internalNote ? `${curr.internalNote}\n\n${textToAppend}` : textToAppend,
    }));
  };

  const handleCopyAdditionalInfoToNote = () => {
    if (!extractedData?.additionalInfo || extractedData.additionalInfo.length === 0) return;
    const hasSensitive = extractedData.additionalInfo.some(
      (info: any) => info.category === 'SENSITIVE' || info.isSensitive
    );

    if (isAdmin && hasSensitive) {
      setCopySensitiveConfirm(true);
      return;
    }

    executeCopyAdditionalInfo(false);
  };

  const handleDiscardImport = async () => {
    if (importSessionId) {
      await apiRequest(`/document-imports/${importSessionId}`, { method: 'DELETE' }).catch(() => {});
    }
    setImportSessionId(null);
    setImportedFile(null);
    setExtractedData(null);
    setForm(initial);
    setEntryMode('manual');
  };

  const handleImportFile = async (file: File) => {
    setImporting(true);
    setImportError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await apiRequest<any>('/document-imports', {
        method: 'POST',
        body: formData,
      });

      // apiRequest unwraps body.data, but handle both { data: session } and session directly
      const session = (res && typeof res === 'object' && 'data' in res && (res as any).data)
        ? (res as any).data
        : res;

      if (!session || typeof session !== 'object' || typeof session.status !== 'string') {
        throw new Error('Não foi possível obter a sessão de importação do servidor.');
      }

      if (session.status === 'READY_FOR_REVIEW' && session.extractedData) {
        setImportSessionId(session.id);
        setImportedFile({ name: session.originalName || file.name, format: session.format || 'DOCUMENT' });
        setExtractedData(session.extractedData);

        const ext = session.extractedData || {};
        setForm(current => {
          let matchedChannelId = current.channelId;
          const chanCand = ext.channelId?.value || ext.channelName?.value || ext.channel?.value;
          if (chanCand && channels && channels.length > 0) {
            const rawChan = String(chanCand).toLowerCase().trim();
            const matched = channels.find(c => c && c.name && (c.name.toLowerCase().includes(rawChan) || rawChan.includes(c.name.toLowerCase())));
            if (matched) matchedChannelId = matched.id;
          }

          let matchedReasonId = current.reasonId;
          if (ext.suggestedReason?.value && reasons && reasons.length > 0) {
            const rawReason = String(ext.suggestedReason.value).toLowerCase().trim();
            const matchedR = reasons.find(r => r && (r.id === ext.suggestedReason.value || (r.name && (r.name.toLowerCase().includes(rawReason) || rawReason.includes(r.name.toLowerCase())))));
            if (matchedR) matchedReasonId = matchedR.id;
          }

          let formattedOpenedAt = current.openedAt;
          if (ext.openedAt?.value) {
            const parsed = new Date(ext.openedAt.value);
            if (!isNaN(parsed.getTime())) {
              formattedOpenedAt = toLocalDateTimeInput(parsed);
            }
          }

          const newItems = (Array.isArray(ext.items) && ext.items.length > 0)
            ? ext.items.map((it: any) => ({
                key: crypto.randomUUID(),
                code: String(it?.code || ''),
                description: String(it?.description || ''),
                batch: String(it?.batch || ''),
                quantity: String(it?.quantity || 1),
                note: String(it?.note || ''),
              }))
            : current.items;

          const extractedRefs: SacReferenceForm[] = [];
          if (Array.isArray(ext.candidateReferences) && ext.candidateReferences.length > 0) {
            for (const cand of ext.candidateReferences) {
              extractedRefs.push({
                key: crypto.randomUUID(),
                type: cand.type,
                value: cand.value,
                note: cand.label || '',
              });
            }
          } else if (ext.invoiceNumber?.value) {
            extractedRefs.push({
              key: crypto.randomUUID(),
              type: 'INVOICE',
              value: ext.invoiceNumber.value,
              note: 'Nota fiscal identificada no formulário',
            });
          }

          if (ext.orderNumber?.value && !extractedRefs.some(r => r.type === 'ORDER' && r.value === ext.orderNumber.value)) {
            extractedRefs.push({
              key: crypto.randomUUID(),
              type: 'ORDER',
              value: ext.orderNumber.value,
              note: '',
            });
          }

          if (ext.externalTicket?.value && !extractedRefs.some(r => (r.type === 'ATTENDANCE' || r.type === 'PROTOCOL') && r.value === ext.externalTicket.value)) {
            extractedRefs.push({
              key: crypto.randomUUID(),
              type: 'ATTENDANCE',
              value: ext.externalTicket.value,
              note: '',
            });
          }

          return {
            ...current,
            customerName: ext.customerName?.value || current.customerName,
            orderNumber: ext.orderNumber?.value || current.orderNumber,
            externalTicket: ext.externalTicket?.value || current.externalTicket,
            references: extractedRefs.length > 0 ? extractedRefs : current.references,
            description: ext.description?.value || current.description,
            channelId: matchedChannelId,
            reasonId: matchedReasonId,
            openedAt: formattedOpenedAt,
            items: newItems,
          };
        });

        if (Array.isArray(ext.candidateDuplicateCases) && ext.candidateDuplicateCases.length > 0) {
          setDuplicateExternal(true);
        }

        setEntryMode('manual');
      } else if (session.status === 'FAILED') {
        setImportError(session.error || 'Falha ao interpretar o formulário.');
      } else {
        setImportError('Status de importação inesperado. Revise o documento manualmente.');
      }
    } catch (err: any) {
      const message = err instanceof Error ? err.message : 'Não foi possível ler o documento.';
      // Ensure technical errors like "Cannot read properties" never leak raw to user
      if (message.includes('Cannot read') || message.includes('undefined') || message.includes('null')) {
        setImportError('Falha ao processar o formulário. Revise o preenchimento ou preencha manualmente.');
      } else {
        setImportError(message);
      }
    } finally {
      setImporting(false);
    }
  };

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

  const requestClose = () => {
    if (dirty) {
      setDiscarding(true);
    } else {
      if (importSessionId) {
        apiRequest(`/document-imports/${importSessionId}`, { method: 'DELETE' }).catch(() => {});
      }
      onClose();
    }
  };

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
      const payload = sacFormPayload(form, allowDuplicate, record?.updatedAt, importSessionId, preserveImportAsAttachment);
      const body = new FormData(); body.append('payload', JSON.stringify(payload)); files.forEach(file => body.append('files', file));
      const saved = await apiRequest<DetailedRecord>(recordId ? `/sac-records/${recordId}` : '/sac-records', { method: recordId ? 'PATCH' : 'POST', body, headers: recordId ? {} : { 'Idempotency-Key': idempotencyKey.current } });
      onSaved(saved, !recordId);
    } catch (error) { setApiError(error instanceof Error ? error.message : 'Não foi possível salvar o registro.'); }
    finally { setSaving(false); }
  };

  return <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget) requestClose(); }}><form ref={modalRef} className="modal sac-form-modal" onSubmit={submit} aria-labelledby="sac-form-title"><header className="modal-head"><div><h2 id="sac-form-title">{editing ? `Editar ${record?.ticket ?? 'registro'}` : 'Novo registro'}</h2><p>{editing ? 'O código interno é imutável.' : 'O código interno será gerado com segurança ao salvar.'}</p></div><button type="button" className="icon-btn" onClick={requestClose} aria-label="Fechar formulário"><X /></button></header>
    {loading ? <div className="sac-form-loading" role="status"><LoaderCircle />Carregando formulário...</div> : optionsError && !reasons.length && !channels.length ? <div className="list-error"><AlertTriangle /><div><strong>Não foi possível preparar o formulário</strong><span>{optionsError}</span></div></div> : <>
      {!editing && !importSessionId && (
        <div className="sac-mode-switcher" role="tablist" aria-label="Modo de preenchimento">
          <button
            type="button"
            role="tab"
            aria-selected={entryMode === 'manual'}
            className={`sac-mode-btn ${entryMode === 'manual' ? 'active' : ''}`}
            onClick={() => setEntryMode('manual')}
          >
            <PenTool style={{ width: 16, height: 16 }} />
            Preencher manualmente
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={entryMode === 'import'}
            className={`sac-mode-btn ${entryMode === 'import' ? 'active' : ''}`}
            onClick={() => setEntryMode('import')}
          >
            <UploadCloud style={{ width: 16, height: 16 }} />
            Importar formulário
          </button>
        </div>
      )}

      {entryMode === 'import' && !importSessionId ? (
        <div className="sac-form-scroll">
          <DocumentImportDropzone
            onFileSelected={handleImportFile}
            isProcessing={importing}
            onCancel={() => { setImporting(false); setEntryMode('manual'); }}
            error={importError}
            onClearError={() => setImportError(null)}
          />
        </div>
      ) : (
        <div className="sac-form-scroll">
          {(!reasons.length || !channels.length) && <section className="sac-catalog-warning" role="alert"><AlertTriangle /><div><strong>Cadastros necessários</strong><p>{!reasons.length && 'Cadastre pelo menos um motivo antes de criar um registro. '}{!channels.length && 'Cadastre pelo menos um canal antes de criar um registro.'}</p></div><button type="button" className="secondary" onClick={onOpenCatalogs}>Abrir Cadastros</button></section>}

          {importSessionId && importedFile && (
            <div className="sac-import-banner">
              <div className="sac-import-banner-content">
                <FileCheck className="sac-import-banner-icon" />
                <div className="sac-import-banner-text">
                  <strong>
                    {importedFile.name}
                    <span className="sac-format-badge">{importedFile.format}</span>
                    {extractedData?.modelName && (
                      <span className="sac-model-badge">{extractedData.modelName}</span>
                    )}
                  </strong>
                  <small>
                    Dados extraídos automaticamente do formulário. Revise os campos antes de confirmar.
                  </small>
                </div>
              </div>
              <button type="button" className="sac-import-discard-btn" onClick={handleDiscardImport} disabled={saving}>
                Descartar importação
              </button>
            </div>
          )}

          {extractedData?.referencedFiles && extractedData.referencedFiles.length > 0 && (
            <div className="sac-referenced-files-alert" role="status">
              <div className="sac-referenced-files-header">
                <Paperclip style={{ width: 16, height: 16 }} />
                <span>Arquivos citados no formulário (não anexados automaticamente):</span>
              </div>
              <div>
                {extractedData.referencedFiles.map((rf: any, idx: number) => (
                  <div key={idx} className="sac-referenced-file-item">
                    <span className="sac-referenced-file-name">{rf.name}</span>
                    <span className="sac-referenced-file-badge">Apenas referenciado no texto</span>
                  </div>
                ))}
              </div>
              <small style={{ display: 'block', marginTop: 4, opacity: 0.9 }}>
                O documento cita estes arquivos como evidência. Se possuir os arquivos originais, anexe-os na seção de Evidências abaixo.
              </small>
            </div>
          )}

          {extractedData?.additionalInfo && extractedData.additionalInfo.length > 0 && (
            <div className="sac-additional-info-card">
              <div className="sac-additional-info-header">
                <div className="sac-additional-info-title">
                  <Info style={{ width: 16, height: 16, color: 'var(--color-accent)' }} />
                  <span>Informações adicionais extraídas ({extractedData.additionalInfo.length})</span>
                </div>
                <button
                  type="button"
                  className="sac-copy-note-btn"
                  onClick={handleCopyAdditionalInfoToNote}
                  title="Copiar estas informações para a observação interna"
                >
                  <Copy style={{ width: 12, height: 12 }} />
                  Copiar para observação interna
                </button>
              </div>
              <div className="sac-additional-info-grid">
                {extractedData.additionalInfo.map((info: any, idx: number) => {
                  const catClass = info.category === 'FISCAL' ? 'sac-additional-category--fiscal'
                    : info.category === 'SENSITIVE' ? 'sac-additional-category--sensitive'
                    : info.category === 'CLINICO' ? 'sac-additional-category--clinico'
                    : info.category === 'CONTATO' ? 'sac-additional-category--contato'
                    : 'sac-additional-category--outros';
                  return (
                    <div key={idx} className="sac-additional-info-row">
                      <div className="sac-additional-label-row">
                        <span className="sac-additional-label">{info.label}</span>
                        {info.category && (
                          <span className={`sac-additional-category ${catClass}`}>
                            {info.category}
                          </span>
                        )}
                        {info.isMasked && (
                          <span className="sac-masked-badge">
                            <Lock style={{ width: 10, height: 10 }} /> Mascarado
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                        <span className="sac-additional-value">{info.value}</span>
                        {info.isMasked && isAdmin && (
                          <button
                            type="button"
                            className="sac-reveal-btn"
                            disabled={revealingIndex === idx}
                            onClick={() => handleRevealImportField(idx)}
                            title="Revelar dado original (somente administradores)"
                          >
                            {revealingIndex === idx ? (
                              <LoaderCircle className="spin" style={{ width: 12, height: 12 }} />
                            ) : (
                              <Eye style={{ width: 12, height: 12 }} />
                            )}
                            Revelar
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {extractedData?.candidateDuplicateCases && extractedData.candidateDuplicateCases.length > 0 && (
            <div className="sac-duplicate-cases-alert" role="alert">
              <header>
                <AlertTriangle style={{ width: 16, height: 16 }} />
                Possível duplicidade identificada
              </header>
              <p style={{ margin: '0 0 6px', fontSize: 'var(--font-size-secondary)' }}>
                Foram encontrados chamados anteriores semelhantes no sistema:
              </p>
              <ul>
                {extractedData.candidateDuplicateCases.map((c: any) => (
                  <li key={c.id}>
                    <strong>{c.ticket}</strong> — {c.customerName} {c.orderNumber ? `(Pedido: ${c.orderNumber})` : ''} {c.externalTicket ? `(Atendimento: ${c.externalTicket})` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {extractedData?.candidateCustomer && (
            <div className="sac-catalog-warning" style={{ borderColor: 'var(--color-accent)', background: 'rgba(2, 132, 199, 0.08)' }}>
              <Check style={{ color: 'var(--color-accent)' }} />
              <div>
                <strong style={{ color: 'var(--color-primary)' }}>Cliente identificado na base</strong>
                <p>O cliente <strong>{extractedData.candidateCustomer.name}</strong> já possui cadastro e será reutilizado sem duplicidade.</p>
              </div>
            </div>
          )}

          <fieldset><legend>1. Identificação</legend><div className="sac-form-grid">
            <label>
              <div className="sac-field-header">
                <span>Cliente *</span>
                <ConfidenceTag field={extractedData?.customerName} />
              </div>
              <input ref={firstFieldRef} data-field="customerName" list="customer-options" value={form.customerName} maxLength={160} onChange={event => change('customerName', event.target.value)} aria-invalid={Boolean(errors.customerName)} />
              <datalist id="customer-options">{customers.map(customer => <option value={customer.name} key={customer.id} />)}</datalist>
              <SnippetHint field={extractedData?.customerName} />
              {errors.customerName && <small>{errors.customerName}</small>}
              <em>Pesquise um cliente existente ou informe um nome para cadastro mínimo.</em>
            </label>

            <label>
              <div className="sac-field-header">
                <span>Canal *</span>
                <ConfidenceTag field={extractedData?.channel} />
              </div>
              <select data-field="channelId" value={form.channelId} onChange={event => change('channelId', event.target.value)} aria-invalid={Boolean(errors.channelId)}>
                <option value="">Selecione conscientemente</option>
                {channels.map(channel => <option value={channel.id} key={channel.id}>{channel.name}</option>)}
              </select>
              <SnippetHint field={extractedData?.channel} />
              {errors.channelId && <small>{errors.channelId}</small>}
            </label>

            <label>
              <div className="sac-field-header">
                <span>Data de abertura *</span>
                <ConfidenceTag field={extractedData?.openedAt} />
              </div>
              <input data-field="openedAt" type="datetime-local" value={form.openedAt} onChange={event => change('openedAt', event.target.value)} aria-invalid={Boolean(errors.openedAt)} />
              <SnippetHint field={extractedData?.openedAt} />
              {errors.openedAt && <small>{errors.openedAt}</small>}
            </label>

            {editing && <label>Código interno<input value={record?.ticket ?? ''} disabled /></label>}
          </div></fieldset>

          <fieldset className="sac-references-section">
            <legend className="sac-references-header">
              <span>Referências do caso (opcional)</span>
              <button
                type="button"
                className="secondary"
                onClick={addReference}
                style={{ fontSize: '12px', padding: '4px 10px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              >
                <Plus style={{ width: 14, height: 14 }} /> Adicionar referência
              </button>
            </legend>

            <p style={{ margin: '4px 0 10px', fontSize: 'var(--font-size-secondary)', color: 'var(--color-text-secondary)' }}>
              Associe identificadores multissetoriais ao caso (pedido, nota fiscal, OS, protocolo, etc.). Opcional para setores que não operam por pedido.
            </p>

            {/* Candidate suggestions from document import */}
            {extractedData && (extractedData.orderNumber?.candidateOrderNumbers?.length > 0 || extractedData.invoiceNumber?.value) && (
              <div className="sac-candidates-helper" style={{ marginBottom: 10 }}>
                <span>Sugestões detectadas no documento:</span>
                {extractedData.orderNumber?.candidateOrderNumbers?.map((num: string) => {
                  const alreadyAdded = form.references.some(r => r.value === num);
                  if (alreadyAdded) return null;
                  return (
                    <button
                      key={num}
                      type="button"
                      className="sac-candidate-chip"
                      onClick={() => setForm(curr => ({
                        ...curr,
                        references: [...curr.references, { key: crypto.randomUUID(), type: 'ORDER', value: num, note: '' }]
                      }))}
                    >
                      + Pedido: {num}
                    </button>
                  );
                })}
                {extractedData.invoiceNumber?.value && !form.references.some(r => r.type === 'INVOICE' && r.value === extractedData.invoiceNumber.value) && (
                  <button
                    type="button"
                    className="sac-candidate-chip"
                    onClick={() => setForm(curr => ({
                      ...curr,
                      references: [...curr.references, { key: crypto.randomUUID(), type: 'INVOICE', value: extractedData.invoiceNumber.value, note: 'Nota fiscal' }]
                    }))}
                  >
                    + NF: {extractedData.invoiceNumber.value}
                  </button>
                )}
              </div>
            )}

            {form.references.length === 0 ? (
              <div className="sac-references-empty">
                Nenhuma referência cadastrada. Caso este chamado não utilize pedido ou nota fiscal, você pode prosseguir sem adicionar referências.
              </div>
            ) : (
              <div className="sac-references-list">
                {form.references.map((ref, index) => (
                  <div key={ref.key || index} className="sac-reference-row">
                    <div className="sac-reference-col">
                      <label>Tipo de referência</label>
                      <select
                        value={ref.type}
                        onChange={e => updateReference(index, { type: e.target.value as SacReferenceType })}
                      >
                        {Object.entries(SAC_REFERENCE_LABELS).map(([val, label]) => (
                          <option key={val} value={val}>{label}</option>
                        ))}
                      </select>
                    </div>

                    <div className="sac-reference-col">
                      <label>Número ou identificador *</label>
                      <input
                        placeholder="Ex.: 123456 ou NF-987"
                        value={ref.value}
                        maxLength={80}
                        onChange={e => updateReference(index, { value: e.target.value })}
                        onBlur={checkExternal}
                      />
                    </div>

                    <div className="sac-reference-col">
                      <label>Observação / detalhe (opcional)</label>
                      <input
                        placeholder="Ex.: Loja centro, canal B2B"
                        value={ref.note}
                        maxLength={200}
                        onChange={e => updateReference(index, { note: e.target.value })}
                      />
                    </div>

                    <button
                      type="button"
                      className="icon-btn"
                      title="Remover referência"
                      aria-label="Remover referência"
                      onClick={() => removeReference(index)}
                      style={{ height: '36px', alignSelf: 'flex-end', marginBottom: '2px' }}
                    >
                      <Trash2 style={{ width: 16, height: 16 }} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {duplicateExternal && (
              <span className="sac-duplicate-warning" style={{ marginTop: '8px', display: 'flex' }}>
                <span>Possível duplicidade encontrada com referência externa.</span>
                <span className="sac-duplicate-confirm">
                  <input
                    type="checkbox"
                    aria-label="Confirmar possível duplicidade"
                    checked={allowDuplicate}
                    onChange={event => setAllowDuplicate(event.target.checked)}
                  />
                  Confirmo que desejo continuar.
                </span>
              </span>
            )}
          </fieldset>

          <fieldset><legend>2. Classificação da ocorrência</legend><div className="sac-form-grid">
            <label>
              <div className="sac-field-header">
                <span>Motivo *</span>
                <ConfidenceTag field={extractedData?.suggestedReason} />
              </div>
              <select data-field="reasonId" value={form.reasonId} onChange={event => change('reasonId', event.target.value)} aria-invalid={Boolean(errors.reasonId)}>
                <option value="">Selecione</option>
                {reasons.map(reason => <option value={reason.id} key={reason.id}>{reason.name}</option>)}
              </select>
              <SnippetHint field={extractedData?.suggestedReason} />
              {errors.reasonId && <small>{errors.reasonId}</small>}
            </label>
            <label>Submotivo<select value={form.subreasonId} onChange={event => change('subreasonId', event.target.value)} disabled={!form.reasonId}><option value="">Sem submotivo</option>{subreasons.map(subreason => <option value={subreason.id} key={subreason.id}>{subreason.name}</option>)}</select></label>
            <label>Prioridade *<select data-field="priority" value={form.priority} disabled={editing} onChange={event => change('priority', event.target.value as SacFormValues['priority'])} aria-invalid={Boolean(errors.priority)}><option value="">Selecione conscientemente</option><option value="LOW">Baixa</option><option value="MEDIUM">Média</option><option value="HIGH">Alta</option><option value="CRITICAL">Crítica</option></select>{errors.priority && <small>{errors.priority}</small>}{editing && <em>Altere pela ação operacional do caso.</em>}</label>
          </div></fieldset>

          <fieldset><legend>3. Descrição</legend><div className="sac-form-grid">
            <label className="full">
              <div className="sac-field-header">
                <span>Descrição completa *</span>
                <ConfidenceTag field={extractedData?.description} />
              </div>
              <textarea data-field="description" value={form.description} maxLength={5000} onChange={event => change('description', event.target.value)} aria-invalid={Boolean(errors.description)} />
              <SnippetHint field={extractedData?.description} />
              {errors.description && <small>{errors.description}</small>}
            </label>
            <label className="full">Observação interna<textarea value={form.internalNote} maxLength={2000} onChange={event => change('internalNote', event.target.value)} /></label>
          </div></fieldset>

          <fieldset><legend>4. Atribuição e prazo</legend><div className="sac-form-grid">
            <label>Responsável<select value={form.assigneeId} disabled={editing} onChange={event => change('assigneeId', event.target.value)}><option value="">Sem responsável</option>{assignees.map(user => <option value={user.id} key={user.id}>{user.name}</option>)}</select>{editing && <em>Altere pela ação operacional do caso.</em>}</label>
            <label>Prazo de resolução *<input data-field="dueDate" type="date" value={form.dueDate} disabled={editing} onChange={event => change('dueDate', event.target.value)} aria-invalid={Boolean(errors.dueDate)} />{errors.dueDate && <small>{errors.dueDate}</small>}<em>{editing ? 'Altere pela ação operacional do caso.' : 'O prazo representa o fim do dia selecionado.'}</em></label>
          </div></fieldset>

          <fieldset><legend>5. Itens envolvidos</legend><div className="sac-section-heading"><p>Opcional. Adicione somente produtos relacionados à ocorrência.</p><button type="button" className="secondary" onClick={() => change('items', [...form.items, createEmptyItem()])}><PackagePlus />Adicionar item</button></div><div className="sac-items">{form.items.map((item, index) => <article key={item.key}><header><strong>Item {index + 1}</strong><button type="button" className="icon-btn" aria-label={`Remover item ${index + 1}`} onClick={() => requestRemoveItem(index)}><Trash2 /></button></header><div className="sac-form-grid"><label>Código ou SKU *<input data-field={`item-${index}`} value={item.code} maxLength={80} onChange={event => changeItem(index, 'code', event.target.value)} /></label><label>Descrição *<input value={item.description} maxLength={300} onChange={event => changeItem(index, 'description', event.target.value)} /></label><label>Lote<input value={item.batch} maxLength={80} onChange={event => changeItem(index, 'batch', event.target.value)} /></label><label>Quantidade reclamada *<input type="number" min="0.001" step="0.001" value={item.quantity} onChange={event => changeItem(index, 'quantity', event.target.value)} /></label><label className="full">Observação<input value={item.note} maxLength={500} onChange={event => changeItem(index, 'note', event.target.value)} /></label>{errors[`item-${index}`] && <small className="full">{errors[`item-${index}`]}</small>}</div></article>)}</div></fieldset>

          <fieldset><legend>6. Evidências ({files.length + (record?.attachments.length ?? 0)}/5)</legend>
            <label className="sac-upload"><Paperclip /><span><strong>Selecionar evidências</strong><small>PDF, JPG, JPEG ou PNG · até 5 arquivos · 10 MB por arquivo</small></span><input type="file" accept={ACCEPTED_FILE_TYPES.join(',')} multiple onChange={addFiles} disabled={saving} /></label>
            {fileError && <p className="sac-field-error" role="alert">{fileError}</p>}
            {importSessionId && importedFile && (
              <label className="sac-preserve-option">
                <input
                  type="checkbox"
                  checked={preserveImportAsAttachment}
                  onChange={(e) => setPreserveImportAsAttachment(e.target.checked)}
                />
                Anexar o formulário original ({importedFile.name}) como evidência do chamado
              </label>
            )}
            <div className="sac-files">
              {record?.attachments.map(file => <article key={file.id}><FileText /><span><strong>{file.originalName}</strong><small>{file.mimeType} · {(file.sizeBytes / 1024).toFixed(1)} KB · já salvo</small></span></article>)}
              {files.map((file, index) => <article key={`${file.name}-${index}`}><FileText /><span><strong>{file.name}</strong><small>{file.type || 'arquivo'} · {(file.size / 1024).toFixed(1)} KB · pronto para envio</small></span><button type="button" className="icon-btn" aria-label={`Remover ${file.name}`} onClick={() => setFiles(current => current.filter((_, fileIndex) => fileIndex !== index))} disabled={saving}><X /></button></article>)}
            </div>
          </fieldset>

          <fieldset><legend>7. Análise interna</legend><div className="sac-form-grid"><label className="full">Causa identificada<textarea value={form.identifiedCause} maxLength={2000} onChange={event => change('identifiedCause', event.target.value)} /></label><label>Área responsável<input value={form.responsibleArea} maxLength={160} onChange={event => change('responsibleArea', event.target.value)} /></label><label className="full">Ação corretiva<textarea value={form.correctiveAction} maxLength={2000} onChange={event => change('correctiveAction', event.target.value)} /></label></div></fieldset>
          {optionsError && <p className="sac-form-api-error" role="alert">{optionsError}</p>}
          {apiError && <p className="sac-form-api-error" role="alert">{apiError}</p>}
        </div>
      )}
    </>}
    <footer className="form-footer">
      <button type="button" className="secondary" onClick={requestClose} disabled={saving}>Cancelar</button>
      <button type="submit" className="primary" disabled={saving || loading || (entryMode === 'import' && !importSessionId)}>
        {saving ? (
          <><LoaderCircle className="spin" />{editing ? 'Salvando...' : 'Criando...'}</>
        ) : editing ? (
          'Salvar alterações'
        ) : importSessionId ? (
          'Revisar e criar registro'
        ) : (
          'Criar registro'
        )}
      </button>
    </footer></form>
    {discarding && <Confirm title="Descartar alterações?" text="Os dados preenchidos e arquivos selecionados não serão salvos." action="Descartar" onCancel={() => setDiscarding(false)} onConfirm={async () => {
      if (importSessionId) {
        await apiRequest(`/document-imports/${importSessionId}`, { method: 'DELETE' }).catch(() => {});
      }
      onClose();
    }} />}
    {removingItem !== null && <Confirm title="Remover item?" text="As informações preenchidas neste item serão descartadas." action="Remover item" onCancel={() => setRemovingItem(null)} onConfirm={() => removeItem(removingItem)} />}
    {copySensitiveConfirm && (
      <div className="overlay sac-confirm-layer">
        <section className="modal sac-confirm" role="alertdialog" aria-modal="true" aria-labelledby="sac-sensitive-confirm-title">
          <header className="modal-head">
            <div>
              <h2 id="sac-sensitive-confirm-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <ShieldAlert style={{ color: 'var(--color-warning)' }} />
                Copiar dados sensíveis para observação?
              </h2>
              <p>
                Os campos adicionais extraídos contêm dados sensíveis (SENSITIVE). Como administrador, você pode confirmar a inclusão desses dados na observação interna ou copiar apenas os campos seguros não sensíveis.
              </p>
            </div>
          </header>
          <footer className="form-footer" style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="secondary"
              onClick={() => setCopySensitiveConfirm(false)}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                executeCopyAdditionalInfo(false);
                setCopySensitiveConfirm(false);
              }}
            >
              Copiar sem dados sensíveis
            </button>
            <button
              type="button"
              className="sac-danger-action"
              onClick={() => {
                executeCopyAdditionalInfo(true);
                setCopySensitiveConfirm(false);
              }}
            >
              Confirmar e incluir sensíveis
            </button>
          </footer>
        </section>
      </div>
    )}
  </div>;
}

