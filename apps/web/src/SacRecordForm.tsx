import { normalizeBatchNumber } from './batch-normalizer';
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  AlertCircle, AlertTriangle, Building2, Check, ChevronDown, Clock, Copy, Eye, EyeOff, FileCheck, FileText, HelpCircle, Info, LoaderCircle,
  Lock, PackagePlus, Paperclip, PenTool, Plus, ShieldAlert, Trash2, UploadCloud, X,
} from 'lucide-react';
import { apiRequest, DEFAULT_USER_DEPARTMENTS, type AuthUser } from './api';
import type { OperationalIndicators } from './data';
import {
  ACCEPTED_FILE_TYPES, createEmptyItem, createEmptyReference, createEmptySacForm, hasUnsavedSacChanges,
  SAC_REFERENCE_LABELS, sacFormPayload, toLocalDateTimeInput, validateAttachments, validateSacForm,
  type PriorityValue, type SacFormErrors, type SacFormValues, type SacReferenceForm, type SacReferenceType,
} from './sac-form';
import { DocumentImportDropzone } from './DocumentImportDropzone';
import './document-import.css';

type Option = { id: string; name: string; active?: boolean };
type CatalogList = { items: Option[] };
export type DetailedRecord = {
  id: string; ticket: string; department?: string | null; orderNumber: string | null; externalTicket: string | null; description: string; internalNote: string | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'; openedAt: string; dueAt: string; updatedAt: string;
  createdAt?: string; completedAt?: string | null;
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
    department: record.department ?? '',
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
  onRecordUpdated,
  onOpenCatalogs,
  initialImportDraft,
}: {
  recordId?: string;
  currentUser?: AuthUser;
  onClose: () => void;
  onSaved: (record: DetailedRecord, created: boolean) => void;
  onRecordUpdated?: (record: DetailedRecord) => void;
  onOpenCatalogs: () => void;
  initialImportDraft?: {
    importSessionId: string;
    importedFile: { name: string; format: string };
    extractedData: any;
    formValues?: Partial<SacFormValues>;
  };
}) {
  const isAdmin = currentUser?.role === 'ADMIN';
  const [form, setForm] = useState<SacFormValues>(() => {
    const base = createEmptySacForm();
    if (initialImportDraft?.formValues) {
      return { ...base, ...initialImportDraft.formValues };
    }
    if (!recordId && currentUser?.role !== 'ADMIN' && currentUser?.department) {
      return { ...base, department: currentUser.department };
    }
    return base;
  });
  const [initial, setInitial] = useState<SacFormValues>(() => {
    const base = createEmptySacForm();
    if (initialImportDraft?.formValues) {
      return { ...base, ...initialImportDraft.formValues };
    }
    if (!recordId && currentUser?.role !== 'ADMIN' && currentUser?.department) {
      return { ...base, department: currentUser.department };
    }
    return base;
  });
  const [record, setRecord] = useState<DetailedRecord | null>(null);
  const [reasons, setReasons] = useState<Option[]>([]); const [subreasons, setSubreasons] = useState<Option[]>([]); const [channels, setChannels] = useState<Option[]>([]); const [assignees, setAssignees] = useState<Option[]>([]); const [customers, setCustomers] = useState<Option[]>([]);
  const [departments, setDepartments] = useState<string[]>([...DEFAULT_USER_DEPARTMENTS]);
  const [loading, setLoading] = useState(() => !initialImportDraft); const [optionsError, setOptionsError] = useState(''); const [saving, setSaving] = useState(false); const [apiError, setApiError] = useState(''); const [errors, setErrors] = useState<SacFormErrors>({});
  const [files, setFiles] = useState<File[]>([]); const [fileError, setFileError] = useState(''); const [duplicateExternal, setDuplicateExternal] = useState(false); const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [discarding, setDiscarding] = useState(false); const [removingItem, setRemovingItem] = useState<number | null>(null);
  const [departmentModalOpen, setDepartmentModalOpen] = useState(false);
  const [targetDepartment, setTargetDepartment] = useState('');
  const [departmentReason, setDepartmentReason] = useState('');
  const [departmentConfirmed, setDepartmentConfirmed] = useState(false);
  const [savingDepartment, setSavingDepartment] = useState(false);
  const [departmentError, setDepartmentError] = useState('');
  const [departmentSuccess, setDepartmentSuccess] = useState('');

  // Document Import state
  const [entryMode, setEntryMode] = useState<'manual' | 'import'>(() => initialImportDraft ? 'import' : 'manual');
  const [importSessionId, setImportSessionId] = useState<string | null>(() => initialImportDraft?.importSessionId || null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importedFile, setImportedFile] = useState<{ name: string; format: string } | null>(() => initialImportDraft?.importedFile || null);
  const [extractedData, setExtractedData] = useState<any | null>(() => initialImportDraft?.extractedData || null);
  const [preserveImportAsAttachment, setPreserveImportAsAttachment] = useState(true);
  const [copySensitiveConfirm, setCopySensitiveConfirm] = useState(false);
  const [revealingIndex, setRevealingIndex] = useState<number | null>(null);
  const [suggestedOpenedAt, setSuggestedOpenedAt] = useState<string>(() => {
    if (initialImportDraft?.extractedData?.openedAt?.requiresReview && initialImportDraft.extractedData.openedAt.value) {
      return toLocalDateTimeInput(new Date(initialImportDraft.extractedData.openedAt.value));
    }
    return '';
  });
  const [openedAtConfirmed, setOpenedAtConfirmed] = useState(false);

  const filteredAdditionalInfo = useMemo(() => {
    if (!extractedData?.additionalInfo || !Array.isArray(extractedData.additionalInfo)) {
      return [];
    }
    return extractedData.additionalInfo.filter((info: any) => {
      if (!info || !info.value) return false;
      const val = String(info.value).trim();
      if (!val || val === '?' || val === '-' || val.toLowerCase() === 'n/a') return false;
      if (info.category === 'FISCAL' && extractedData.invoiceNumber?.value && val === extractedData.invoiceNumber.value) {
        return false;
      }
      return true;
    });
  }, [extractedData]);

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

  const handleHideImportField = (index: number) => {
    setExtractedData((prev: any) => {
      if (!prev || !Array.isArray(prev.additionalInfo)) return prev;
      const updated = [...prev.additionalInfo];
      if (updated[index]) {
        updated[index] = {
          ...updated[index],
          value: '***',
          isMasked: true,
        };
      }
      return { ...prev, additionalInfo: updated };
    });
  };

  const handleRevealImportField = async (index: number) => {
    if (!importSessionId || !isAdmin) return;
    if (!window.confirm('Confirma a revelação deste dado sensível? Esta ação gerará um registro de auditoria.')) {
      return;
    }
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

  const [revealingRefFileIndex, setRevealingRefFileIndex] = useState<number | null>(null);

  const handleRevealReferencedFile = async (fileIndex: number) => {
    if (!importSessionId || !isAdmin) return;
    if (!window.confirm('Confirma a revelação deste nome de arquivo sensível? Esta ação gerará um registro de auditoria.')) {
      return;
    }
    setRevealingRefFileIndex(fileIndex);
    try {
      const res = await apiRequest<{ revealedValue: string; category: string }>(
        `/document-imports/${importSessionId}/reveal`,
        {
          method: 'POST',
          body: JSON.stringify({ fieldName: 'referencedFiles', fileIndex }),
        }
      );
      if (res && res.revealedValue) {
        setExtractedData((prev: any) => {
          if (!prev || !Array.isArray(prev.referencedFiles)) return prev;
          const updated = [...prev.referencedFiles];
          if (updated[fileIndex]) {
            updated[fileIndex] = {
              ...updated[fileIndex],
              name: res.revealedValue,
              isMasked: false,
            };
          }
          return { ...prev, referencedFiles: updated };
        });
      }
    } catch (err: any) {
      alert(err.message || 'Não foi possível revelar o nome do arquivo.');
    } finally {
      setRevealingRefFileIndex(null);
    }
  };

  const handleHideReferencedFile = (fileIndex: number) => {
    setExtractedData((prev: any) => {
      if (!prev || !Array.isArray(prev.referencedFiles)) return prev;
      const updated = [...prev.referencedFiles];
      if (updated[fileIndex]) {
        updated[fileIndex] = {
          ...updated[fileIndex],
          name: '***',
          isMasked: true,
        };
      }
      return { ...prev, referencedFiles: updated };
    });
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
    setSuggestedOpenedAt('');
    setOpenedAtConfirmed(false);
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

        if (ext.openedAt?.requiresReview && ext.openedAt.value) {
          const parsed = new Date(ext.openedAt.value);
          if (!isNaN(parsed.getTime())) {
            setSuggestedOpenedAt(toLocalDateTimeInput(parsed));
            setOpenedAtConfirmed(false);
          }
        } else {
          setSuggestedOpenedAt('');
          setOpenedAtConfirmed(false);
        }

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
          if (ext.openedAt?.value && !ext.openedAt.requiresReview) {
            const parsed = new Date(ext.openedAt.value);
            if (!isNaN(parsed.getTime())) {
              formattedOpenedAt = toLocalDateTimeInput(parsed);
            }
          }

          const newItems = (Array.isArray(ext.items) && ext.items.length > 0)
            ? ext.items.map((it: any) => {
                const rawBatch = it?.batch || it?.rawBatch || '';
                const batchNorm = normalizeBatchNumber(rawBatch);
                const hasExplicitQty = it?.hasExplicitQuantity !== false && it?.quantity !== undefined && it?.quantity !== null && it?.quantity > 0;
                return {
                  key: crypto.randomUUID(),
                  code: String(it?.code || ''),
                  description: String(it?.description || ''),
                  batch: it?.batch && /^[0-9]{6}$/.test(it.batch) ? it.batch : (batchNorm.status === 'VALID' ? batchNorm.batch : ''),
                  quantity: hasExplicitQty ? String(it.quantity) : '',
                  note: String(it?.note || ''),
                  batchStatus: it?.batchStatus || batchNorm.status,
                  batchSnippet: it?.sourceSnippet || batchNorm.sourceSnippet,
                  batchWarning: it?.warning || batchNorm.warning,
                  batchNotice: it?.batchNotice || batchNorm.displayNotice || (batchNorm.status === 'EMPTY' ? 'O lote não foi informado no documento.' : undefined),
                  batchRequiresReview: it?.requiresReview ?? batchNorm.requiresReview,
                  batchCandidates: it?.batchCandidates || batchNorm.candidates,
                };
              })
            : current.items;

          const extractedRefs: SacReferenceForm[] = [];
          if (Array.isArray(ext.candidateReferences) && ext.candidateReferences.length > 0) {
            for (const cand of ext.candidateReferences) {
              if (cand.value && !extractedRefs.some(r => r.type === cand.type && r.value === cand.value)) {
                extractedRefs.push({
                  key: crypto.randomUUID(),
                  type: cand.type,
                  value: cand.value,
                  note: cand.label || '',
                });
              }
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
    if (initialImportDraft) {
      setReasons([
        { id: 'reason-1', name: 'Não osseointegração' },
        { id: 'reason-2', name: 'Fratura de componente' },
      ]);
      setChannels([
        { id: 'channel-1', name: 'Formulário' },
        { id: 'channel-2', name: 'E-mail' },
      ]);
      setAssignees([
        { id: 'user-1', name: 'Atendente Qualidade' },
      ]);
      setLoading(false);
      return;
    }
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
      else {
        const values = createEmptySacForm();
        if (currentUser?.role !== 'ADMIN' && currentUser?.department) {
          values.department = currentUser.department;
        }
        setForm(values);
        setInitial(values);
      }
    }).catch(error => { if (active) setOptionsError(error instanceof Error ? error.message : 'Não foi possível carregar o formulário.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [recordId, currentUser]);

  useEffect(() => {
    if (initialImportDraft) {
      setSubreasons([
        { id: 'sub-1', name: 'Mobilidade clínica observada' },
        { id: 'sub-2', name: 'Ausência de travamento ósseo' },
      ]);
      return;
    }
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
    if (initialImportDraft) return;
    apiRequest<string[] | { departments: string[] }>('/users/departments')
      .then(result => {
        const list = Array.isArray(result) ? result : result?.departments;
        if (Array.isArray(list) && list.length > 0) {
          setDepartments(Array.from(new Set([...DEFAULT_USER_DEPARTMENTS, ...list])));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isAdmin || editing) return;
    const query = form.department ? `?department=${encodeURIComponent(form.department)}` : '';
    apiRequest<Option[]>(`/users/assignable${query}`)
      .then(list => {
        setAssignees(list);
        setForm(curr => {
          if (curr.assigneeId && !list.some(u => u.id === curr.assigneeId)) {
            return { ...curr, assigneeId: '' };
          }
          return curr;
        });
      })
      .catch(() => {});
  }, [form.department, isAdmin, editing]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', beforeUnload); return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  const openDepartmentModal = () => {
    setTargetDepartment(form.department || record?.department || '');
    setDepartmentReason('');
    setDepartmentConfirmed(false);
    setDepartmentError('');
    setDepartmentModalOpen(true);
  };

  const handleSaveDepartment = async (event: FormEvent) => {
    event.preventDefault();
    if (!recordId || !isAdmin || savingDepartment) return;
    const trimmed = targetDepartment.trim();
    if (!trimmed) {
      setDepartmentError('Selecione um setor.');
      return;
    }
    const currentDept = form.department || record?.department;
    if (currentDept && trimmed === currentDept) {
      setDepartmentError('O caso já pertence a este setor. Selecione um setor diferente.');
      return;
    }
    if (!departmentConfirmed) {
      setDepartmentError('Confirme a transferência antes de continuar.');
      return;
    }

    setSavingDepartment(true);
    setDepartmentError('');
    try {
      const updated = await apiRequest<DetailedRecord>(`/sac-records/${recordId}/department`, {
        method: 'PATCH',
        body: JSON.stringify({
          department: trimmed,
          justification: departmentReason.trim() || undefined,
          updatedAt: record?.updatedAt,
        }),
      });

      setForm(curr => ({
        ...curr,
        department: trimmed,
        ...(updated.assignee ? {} : (curr.assigneeId === record?.assignee?.id ? { assigneeId: '' } : {})),
      }));
      setInitial(curr => ({ ...curr, department: trimmed }));
      setRecord(prev => prev ? {
        ...prev,
        ...updated,
        department: trimmed,
        updatedAt: updated.updatedAt,
      } : updated);
      if (onRecordUpdated) {
        onRecordUpdated(updated);
      }
      setDepartmentSuccess(currentDept ? 'Setor alterado com sucesso.' : 'Setor definido com sucesso.');
      setDepartmentModalOpen(false);
      setTimeout(() => setDepartmentSuccess(''), 4000);
    } catch (err: any) {
      setDepartmentError(err instanceof Error ? err.message : 'Não foi possível alterar o setor.');
    } finally {
      setSavingDepartment(false);
    }
  };

  const requestClose = () => {
    if (dirty) {
      setDiscarding(true);
    } else {
      setExtractedData(null);
      if (importSessionId) {
        apiRequest(`/document-imports/${importSessionId}`, { method: 'DELETE' }).catch(() => {});
      }
      onClose();
    }
  };

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (departmentModalOpen) {
          if (!savingDepartment) setDepartmentModalOpen(false);
        } else if (discarding) {
          setDiscarding(false);
        } else if (removingItem !== null) {
          setRemovingItem(null);
        } else {
          requestClose();
        }
        return;
      }
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
  const changeItemMeta = (index: number, patch: Partial<SacFormValues['items'][number]>) => setForm(current => ({ ...current, items: current.items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) }));
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
    const selected = [...files, ...Array.from(event.target.files ?? [])]; const issue = validateAttachments(selected, record?.attachments?.length ?? 0);
    if (issue) setFileError(issue); else { setFiles(selected); setFileError(''); }
    event.target.value = '';
  };
  const focusFirstError = (nextErrors: SacFormErrors) => requestAnimationFrame(() => {
    const key = Object.keys(nextErrors)[0]; if (key) modalRef.current?.querySelector<HTMLElement>(`[data-field="${key}"]`)?.focus();
  });
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (saving) return;
    const nextErrors = validateSacForm(form, isAdmin, editing);
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
                    Dados extraídos do formulário. Revise os campos preenchidos antes de confirmar.
                  </small>
                </div>
              </div>
              <button type="button" className="sac-import-discard-btn" onClick={handleDiscardImport} disabled={saving}>
                Descartar importação
              </button>
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

          {/* 1. IDENTIFICAÇÃO E REFERÊNCIAS */}
          <fieldset>
            <legend>1. Identificação e referências do caso</legend>
            <div className="sac-form-grid">
              {!editing ? (
                isAdmin ? (
                  <label>
                    <div className="sac-field-header">
                      <span>Setor *</span>
                    </div>
                    <select
                      data-field="department"
                      value={form.department || ''}
                      onChange={event => change('department', event.target.value)}
                      aria-invalid={Boolean(errors.department)}
                    >
                      <option value="">Selecione o setor</option>
                      {(departments || []).map(dept => (
                        <option key={dept} value={dept}>{dept}</option>
                      ))}
                    </select>
                    {errors.department && <small>{errors.department}</small>}
                  </label>
                ) : (
                  <label>
                    <div className="sac-field-header">
                      <span>Setor</span>
                    </div>
                    <input
                      value={currentUser?.department || 'Sem setor vinculado'}
                      disabled
                      readOnly
                      aria-label="Setor do caso (somente leitura)"
                    />
                    <small style={{ color: 'var(--color-muted)' }}>
                      Vinculado automaticamente ao seu setor de atuação.
                    </small>
                  </label>
                )
              ) : (
                <label>
                  <div className="sac-field-header">
                    <span>Setor</span>
                  </div>
                  {isAdmin ? (
                    <div className="sac-department-control">
                      <input
                        value={form.department || record?.department || 'Sem setor definido'}
                        disabled
                        readOnly
                        aria-label="Setor do caso (somente leitura na edição)"
                      />
                      <button
                        type="button"
                        className="sac-department-btn"
                        onClick={openDepartmentModal}
                        title="Abrir fluxo de transferência de setor com confirmação e auditoria"
                      >
                        <Building2 style={{ width: 14, height: 14 }} />
                        {form.department || record?.department ? 'Alterar setor' : 'Definir setor'}
                      </button>
                    </div>
                  ) : (
                    <input
                      value={form.department || record?.department || 'Sem setor definido'}
                      disabled
                      readOnly
                      aria-label="Setor do caso (somente leitura na edição)"
                    />
                  )}
                  {departmentSuccess && (
                    <span className="sac-dept-success-tag">
                      <Check style={{ width: 13, height: 13 }} />
                      {departmentSuccess}
                    </span>
                  )}
                  <small style={{ color: 'var(--color-muted)' }}>
                    {isAdmin
                      ? 'O setor é somente leitura na edição comum. Utilize o botão para transferir via fluxo auditado.'
                      : 'A alteração de setor é restrita ao perfil de Administrador.'}
                  </small>
                </label>
              )}

              <label>
                <div className="sac-field-header">
                  <span>Cliente *</span>
                  <ConfidenceTag field={extractedData?.customerName} />
                </div>
                <input
                  ref={firstFieldRef}
                  data-field="customerName"
                  list="customer-options"
                  value={form.customerName}
                  maxLength={160}
                  onChange={event => change('customerName', event.target.value)}
                  aria-invalid={Boolean(errors.customerName)}
                />
                <datalist id="customer-options">{(Array.isArray(customers) ? customers : []).map(customer => <option value={customer.name} key={customer.id} />)}</datalist>
                <SnippetHint field={extractedData?.customerName} />
                {errors.customerName && <small>{errors.customerName}</small>}
                <em>Pesquise um cliente existente ou informe um nome para cadastro mínimo.</em>
              </label>

              <label>
                <div className="sac-field-header">
                  <span>Canal *</span>
                  <ConfidenceTag field={extractedData?.channelId || extractedData?.channelName} />
                </div>
                <select data-field="channelId" value={form.channelId} onChange={event => change('channelId', event.target.value)} aria-invalid={Boolean(errors.channelId)}>
                  <option value="">Selecione conscientemente</option>
                  {(channels || []).map(channel => <option value={channel.id} key={channel.id}>{channel.name}</option>)}
                </select>
                <SnippetHint field={extractedData?.channelId || extractedData?.channelName} />
                {errors.channelId && <small>{errors.channelId}</small>}
              </label>

              <label>
                <div className="sac-field-header">
                  <span>Data da ocorrência / abertura *</span>
                  <ConfidenceTag field={extractedData?.openedAt} />
                </div>
                <input
                  data-field="openedAt"
                  type="datetime-local"
                  value={form.openedAt}
                  onChange={event => {
                    change('openedAt', event.target.value);
                    if (suggestedOpenedAt && event.target.value === suggestedOpenedAt) {
                      setOpenedAtConfirmed(true);
                    }
                  }}
                  aria-invalid={Boolean(errors.openedAt)}
                />
                {suggestedOpenedAt && !openedAtConfirmed && (
                  <div className="sac-opened-at-suggestion-box" role="region" aria-label="Sugestão de data pendente">
                    <div className="sac-opened-at-suggestion-text">
                      <Clock style={{ width: 14, height: 14, color: 'var(--color-warning)' }} />
                      <span>
                        <strong>Data encontrada no documento:</strong> {suggestedOpenedAt.replace('T', ' às ')} ({extractedData?.openedAt?.warning || 'Atendimento de origem'}).
                        A data de criação deste novo registro (createdAt) será a data atual. A data encontrada no documento é tratada como sugestão sujeita à sua confirmação.
                      </span>
                    </div>
                    <button
                      type="button"
                      className="sac-btn-accept-date"
                      onClick={() => {
                        change('openedAt', suggestedOpenedAt);
                        setOpenedAtConfirmed(true);
                      }}
                    >
                      <Check style={{ width: 12, height: 12 }} />
                      Confirmar e usar data sugerida ({suggestedOpenedAt.replace('T', ' ')})
                    </button>
                  </div>
                )}
                <SnippetHint field={extractedData?.openedAt} />
                {errors.openedAt && <small>{errors.openedAt}</small>}
              </label>

              {editing && <label>Código interno<input value={record?.ticket ?? ''} disabled /></label>}
            </div>

            {/* Subseção de Referências Integrada */}
            <div className="sac-references-subblock">
              <div className="sac-references-header">
                <strong>Referências do caso (opcional)</strong>
                <button
                  type="button"
                  className="secondary"
                  onClick={addReference}
                  style={{ fontSize: '12px', padding: '4px 10px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                >
                  <Plus style={{ width: 14, height: 14 }} /> Adicionar referência
                </button>
              </div>

              <p className="sac-references-intro">
                Associe identificadores do caso (pedido, nota fiscal, OS, protocolo, etc.).
              </p>

              {/* Candidate suggestions from document import (only show if not already added to form.references) */}
              {extractedData && (
                (() => {
                  const orderSuggestions = (extractedData.orderNumber?.candidateOrderNumbers || [])
                    .filter((num: string) => !form.references.some(r => r.type === 'ORDER' && r.value === num));
                  const invoiceCandidate = extractedData.invoiceNumber?.value && !form.references.some(r => r.type === 'INVOICE' && r.value === extractedData.invoiceNumber.value)
                    ? extractedData.invoiceNumber.value
                    : null;

                  if (orderSuggestions.length === 0 && !invoiceCandidate) return null;

                  return (
                    <div className="sac-candidates-helper" style={{ marginBottom: 10 }}>
                      <span>Sugestões detectadas no documento:</span>
                      {orderSuggestions.map((num: string) => (
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
                      ))}
                      {invoiceCandidate && (
                        <button
                          type="button"
                          className="sac-candidate-chip"
                          onClick={() => setForm(curr => ({
                            ...curr,
                            references: [...curr.references, { key: crypto.randomUUID(), type: 'INVOICE', value: invoiceCandidate, note: '' }]
                          }))}
                        >
                          + NF: {invoiceCandidate}
                        </button>
                      )}
                    </div>
                  );
                })()
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
                        />
                      </div>

                      <div className="sac-reference-col">
                        <label>Observação complementar (opcional)</label>
                        <input
                          placeholder="Ex.: Emissão 12/03 ou Matriz"
                          value={ref.note || ''}
                          maxLength={120}
                          onChange={e => updateReference(index, { note: e.target.value })}
                        />
                      </div>

                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`Remover referência ${ref.value || index + 1}`}
                        onClick={() => removeReference(index)}
                        style={{ height: '36px', alignSelf: 'flex-end', marginBottom: '2px' }}
                      >
                        <Trash2 style={{ width: 16, height: 16 }} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </fieldset>

          {/* 2. OCORRÊNCIA E ITENS ENVOLVIDOS */}
          <fieldset>
            <legend>2. Ocorrência e itens envolvidos</legend>
            <div className="sac-form-grid">
              <label>
                <div className="sac-field-header">
                  <span>Motivo *</span>
                  <ConfidenceTag field={extractedData?.suggestedReason} />
                </div>
                <select data-field="reasonId" value={form.reasonId} onChange={event => change('reasonId', event.target.value)} aria-invalid={Boolean(errors.reasonId)}>
                  <option value="">Selecione o motivo</option>
                  {(reasons || []).map(reason => <option value={reason.id} key={reason.id}>{reason.name}</option>)}
                </select>
                <SnippetHint field={extractedData?.suggestedReason} />
                {errors.reasonId && <small>{errors.reasonId}</small>}
              </label>

              <label>
                <span>Submotivo</span>
                <select value={form.subreasonId} disabled={!form.reasonId} onChange={event => change('subreasonId', event.target.value)}>
                  <option value="">Sem submotivo</option>
                  {(subreasons || []).map(subreason => <option value={subreason.id} key={subreason.id}>{subreason.name}</option>)}
                </select>
              </label>

              <label>
                <span>Prioridade *</span>
                <select data-field="priority" value={form.priority} onChange={event => change('priority', event.target.value as PriorityValue)} aria-invalid={Boolean(errors.priority)}>
                  <option value="">Defina a prioridade</option>
                  <option value="LOW">Baixa</option>
                  <option value="MEDIUM">Média</option>
                  <option value="HIGH">Alta</option>
                  <option value="CRITICAL">Crítica</option>
                </select>
                {errors.priority && <small>{errors.priority}</small>}
              </label>

              <label className="full">
                <div className="sac-field-header">
                  <span>Descrição detalhada da ocorrência *</span>
                  <ConfidenceTag field={extractedData?.description} />
                </div>
                <textarea data-field="description" value={form.description} maxLength={5000} onChange={event => change('description', event.target.value)} aria-invalid={Boolean(errors.description)} />
                <SnippetHint field={extractedData?.description} />
                {errors.description && <small>{errors.description}</small>}
              </label>
            </div>

            {/* Itens envolvidos integrados */}
            <div className="sac-items-subblock">
              <div className="sac-section-heading">
                <div>
                  <strong>Produtos envolvidos na ocorrência</strong>
                  <p>Opcional. Adicione os produtos e lotes relacionados ao problema.</p>
                </div>
                <button type="button" className="secondary" onClick={() => change('items', [...form.items, createEmptyItem()])}>
                  <PackagePlus /> Adicionar item
                </button>
              </div>
              <div className="sac-items">
                {form.items.map((item, index) => (
                  <article key={item.key}>
                    <header>
                      <strong>Item {index + 1}</strong>
                      <button type="button" className="icon-btn" aria-label={`Remover item ${index + 1}`} onClick={() => requestRemoveItem(index)}>
                        <Trash2 />
                      </button>
                    </header>
                    <div className="sac-form-grid">
                      <label>
                        Código ou SKU *
                        <input data-field={`item-${index}`} value={item.code} maxLength={80} onChange={event => changeItem(index, 'code', event.target.value)} />
                      </label>
                      <label>
                        Descrição *
                        <input value={item.description} maxLength={300} onChange={event => changeItem(index, 'description', event.target.value)} />
                      </label>
                      <label>
                        <div className="sac-field-header">
                          <span>Lote</span>
                          {item.batchRequiresReview && (
                            <span className="sac-badge sac-badge-review">Revisão necessária</span>
                          )}
                          {item.batch && /^[0-9]{6}$/.test(item.batch) && !item.batchRequiresReview && (
                            <span className="sac-badge sac-badge-identified">Identificado</span>
                          )}
                        </div>
                        <input
                          data-field={`item-batch-${index}`}
                          value={item.batch}
                          maxLength={80}
                          placeholder={item.batchNotice ? 'Não informado' : 'Ex: 146157'}
                          onChange={event => {
                            const val = event.target.value;
                            changeItem(index, 'batch', val);
                            if (/^[0-9]{6}$/.test(val.trim())) {
                              changeItemMeta(index, { batchRequiresReview: false, batchWarning: undefined, batchStatus: 'VALID' });
                            }
                          }}
                        />
                        {(!item.batch && (item.batchNotice || item.batchStatus === 'EMPTY')) && (
                          <span className="sac-batch-notice" role="status">
                            O lote não foi informado no documento.
                          </span>
                        )}
                        {item.batchRequiresReview && item.batchWarning && (
                          <span className="sac-field-snippet" style={{ color: 'var(--color-warning, #d97706)' }}>
                            {item.batchWarning}
                          </span>
                        )}
                        {item.batchSnippet && (
                          <span className="sac-field-snippet" title={item.batchSnippet}>
                            Trecho de origem: &ldquo;{item.batchSnippet}&rdquo;
                          </span>
                        )}
                        {item.batchCandidates && item.batchCandidates.length > 1 && (
                          <div className="sac-batch-candidates">
                            <span className="sac-batch-candidates-title">Lotes detectados no trecho (selecione sem unificar):</span>
                            <div className="sac-batch-chips">
                              {item.batchCandidates.map(cand => (
                                <button
                                  key={cand}
                                  type="button"
                                  className="sac-btn-chip"
                                  onClick={() => {
                                    changeItem(index, 'batch', cand);
                                    changeItemMeta(index, { batchRequiresReview: false, batchWarning: undefined, batchStatus: 'VALID' });
                                  }}
                                >
                                  Lote {cand}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </label>
                      <label>
                        Quantidade reclamada *
                        <input type="number" min="0.001" step="0.001" value={item.quantity} onChange={event => changeItem(index, 'quantity', event.target.value)} />
                      </label>
                      <label className="full">
                        Observação
                        <input value={item.note} maxLength={500} onChange={event => changeItem(index, 'note', event.target.value)} />
                      </label>
                      {errors[`item-${index}`] && <small className="full">{errors[`item-${index}`]}</small>}
                    </div>
                  </article>
                ))}
              </div>
            </div>

            <div className="sac-form-grid" style={{ marginTop: 'var(--space-3)' }}>
              <label className="full">
                Observação interna
                <textarea value={form.internalNote} maxLength={2000} onChange={event => change('internalNote', event.target.value)} />
              </label>
            </div>
          </fieldset>

          {/* 3. CONTATO E DADOS COMPLEMENTARES (RECOLHÍVEL) */}
          {filteredAdditionalInfo.length > 0 && (
            <details className="sac-collapsible-section">
              <summary className="sac-collapsible-summary">
                <div className="sac-collapsible-header-left">
                  <strong>
                    <Info style={{ width: 16, height: 16, color: 'var(--color-accent)' }} />
                    3. Contato e dados complementares da importação
                  </strong>
                  <span className="sac-collapsible-count-badge">
                    {filteredAdditionalInfo.length} campos
                  </span>
                  <span className="sac-collapsible-tag-masked">
                    <Lock style={{ width: 10, height: 10 }} /> Dados sensíveis mascarados (***)
                  </span>
                </div>
                <ChevronDown className="sac-collapsible-arrow" />
              </summary>

              <div className="sac-collapsible-content">
                <div className="sac-collapsible-actions">
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
                  {filteredAdditionalInfo.map((info: any, idx: number) => {
                    const originalIdx = extractedData.additionalInfo.findIndex((orig: any) => orig === info || (orig.label === info.label && orig.value === info.value));
                    const actualIdx = originalIdx >= 0 ? originalIdx : idx;
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
                          {info.isMasked ? (
                            isAdmin && (
                              <button
                                type="button"
                                className="sac-reveal-btn"
                                disabled={revealingIndex === actualIdx}
                                onClick={() => handleRevealImportField(actualIdx)}
                                title="Revelar dado original (somente administradores)"
                              >
                                {revealingIndex === actualIdx ? (
                                  <LoaderCircle className="spin" style={{ width: 12, height: 12 }} />
                                ) : (
                                  <Eye style={{ width: 12, height: 12 }} />
                                )}
                                Revelar
                              </button>
                            )
                          ) : (
                            isAdmin && (
                              <button
                                type="button"
                                className="sac-reveal-btn sac-hide-btn"
                                onClick={() => handleHideImportField(actualIdx)}
                                title="Ocultar dado sensível"
                              >
                                <EyeOff style={{ width: 12, height: 12 }} />
                                Ocultar
                              </button>
                            )
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </details>
          )}

          {/* 4. EVIDÊNCIAS */}
          <fieldset>
            <legend>4. Evidências ({files.length + (record?.attachments?.length ?? 0)}/5)</legend>

            {/* Evidências citadas separadas dos arquivos anexados */}
            {extractedData?.referencedFiles && extractedData.referencedFiles.length > 0 && (
              <div className="sac-referenced-files-alert" role="status">
                <div className="sac-referenced-files-header">
                  <Paperclip style={{ width: 16, height: 16 }} />
                  <strong>Evidências citadas no formulário (não anexadas ao arquivo)</strong>
                </div>
                <p style={{ margin: '4px 0 8px', fontSize: 'var(--font-size-secondary)', color: 'var(--color-text-secondary)' }}>
                  Os arquivos abaixo foram mencionados no formulário original, mas não vieram incorporados no documento. Se você os recebeu separadamente (e-mail, WhatsApp, etc.), anexe-os abaixo:
                </p>
                <div>
                  {extractedData.referencedFiles.map((rf: any, idx: number) => (
                    <div key={idx} className="sac-referenced-file-item" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <span className={`sac-referenced-file-name ${rf.isMasked ? 'masked-sensitive-value' : ''}`}>{rf.name}</span>
                        <span className="sac-referenced-file-badge">Apenas citado no texto</span>
                        {rf.isMasked && (
                          <span className="badge-sensitive" title="Contém dados pessoais protegidos por LGPD">Identificação pessoal</span>
                        )}
                      </div>
                      {isAdmin && (
                        rf.isMasked ? (
                          <button
                            type="button"
                            className="btn-reveal-sensitive"
                            title="Revelar nome original do arquivo citado (requer permissão de Administrador e gera registro de auditoria)"
                            onClick={() => handleRevealReferencedFile(idx)}
                            disabled={revealingRefFileIndex === idx}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', padding: '2px 6px' }}
                          >
                            <Eye style={{ width: 12, height: 12 }} />
                            <span>{revealingRefFileIndex === idx ? 'Revelando...' : 'Revelar'}</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn-reveal-sensitive"
                            title="Ocultar nome do arquivo novamente"
                            onClick={() => handleHideReferencedFile(idx)}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', padding: '2px 6px' }}
                          >
                            <EyeOff style={{ width: 12, height: 12 }} />
                            <span>Ocultar</span>
                          </button>
                        )
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <label className="sac-upload">
              <Paperclip />
              <span>
                <strong>Selecionar evidências</strong>
                <small>PDF, JPG, JPEG ou PNG · até 5 arquivos · 10 MB por arquivo</small>
              </span>
              <input type="file" accept={ACCEPTED_FILE_TYPES.join(',')} multiple onChange={addFiles} disabled={saving} />
            </label>
            {fileError && <p className="sac-field-error" role="alert">{fileError}</p>}
            {importSessionId && importedFile && (
              <label className="sac-preserve-option">
                <input
                  type="checkbox"
                  checked={preserveImportAsAttachment}
                  onChange={(e) => setPreserveImportAsAttachment(e.target.checked)}
                />
                Anexar o formulário original ({importedFile.name}) como evidência deste chamado
              </label>
            )}
            <div className="sac-files">
              {(record?.attachments || []).map(file => (
                <article key={file.id}>
                  <FileText />
                  <span>
                    <strong>{file.originalName}</strong>
                    <small>{file.mimeType} · {(file.sizeBytes / 1024).toFixed(1)} KB · já salvo</small>
                  </span>
                </article>
              ))}
              {files.map((file, index) => (
                <article key={`${file.name}-${index}`}>
                  <FileText />
                  <span>
                    <strong>{file.name}</strong>
                    <small>{file.type || 'arquivo'} · {(file.size / 1024).toFixed(1)} KB · pronto para envio</small>
                  </span>
                  <button type="button" className="icon-btn" aria-label={`Remover ${file.name}`} onClick={() => setFiles(current => current.filter((_, fileIndex) => fileIndex !== index))} disabled={saving}>
                    <X />
                  </button>
                </article>
              ))}
            </div>
          </fieldset>

          {/* 5. TRATATIVA E RESPOSTA OPERACIONAL */}
          <fieldset>
            <legend>5. Tratativa e resposta operacional</legend>
            <div className="sac-section-heading">
              <p>Preenchimento durante o atendimento pelo operador responsável.</p>
            </div>
            <div className="sac-form-grid">
              <label>
                Responsável
                <select value={form.assigneeId} disabled={editing} onChange={event => change('assigneeId', event.target.value)}>
                  <option value="">Sem responsável</option>
                  {(assignees || []).map(user => <option value={user.id} key={user.id}>{user.name}</option>)}
                </select>
                {editing && <em>Altere pela ação operacional do caso.</em>}
              </label>
              <label>
                Prazo de resolução *
                <input data-field="dueDate" type="date" value={form.dueDate} disabled={editing} onChange={event => change('dueDate', event.target.value)} aria-invalid={Boolean(errors.dueDate)} />
                {errors.dueDate && <small>{errors.dueDate}</small>}
                <em>{editing ? 'Altere pela ação operacional do caso.' : 'O prazo representa o fim do dia selecionado.'}</em>
              </label>
            </div>

            {editing && (
              <div style={{ marginTop: 'var(--space-3)' }}>
                <div className="sac-section-heading">
                  <strong>Análise interna e ação corretiva</strong>
                </div>
                <div className="sac-form-grid">
                  <label className="full">
                    Causa identificada
                    <textarea value={form.identifiedCause} maxLength={2000} onChange={event => change('identifiedCause', event.target.value)} />
                  </label>
                  <label>
                    Área responsável
                    <input value={form.responsibleArea} maxLength={160} onChange={event => change('responsibleArea', event.target.value)} />
                  </label>
                  <label className="full">
                    Ação corretiva
                    <textarea value={form.correctiveAction} maxLength={2000} onChange={event => change('correctiveAction', event.target.value)} />
                  </label>
                </div>
              </div>
            )}
          </fieldset>

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
      setExtractedData(null);
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
    {departmentModalOpen && (
      <div
        className="overlay sac-confirm-layer"
        onMouseDown={e => {
          if (e.target === e.currentTarget && !savingDepartment) setDepartmentModalOpen(false);
        }}
      >
        <section
          className="modal sac-department-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sac-dept-modal-title"
        >
          <header className="modal-head">
            <div>
              <h2 id="sac-dept-modal-title">
                {form.department || record?.department ? 'Alterar setor do caso' : 'Definir setor do caso'}
              </h2>
              <p>
                {form.department || record?.department
                  ? 'Transferência com confirmação e registro de auditoria.'
                  : 'Classificação com confirmação e registro de auditoria.'}
              </p>
            </div>
            <button
              type="button"
              className="icon-btn"
              disabled={savingDepartment}
              onClick={() => setDepartmentModalOpen(false)}
              aria-label="Fechar"
            >
              <X />
            </button>
          </header>

          {departmentError && (
            <div className="inline-error" role="alert" style={{ margin: 'var(--space-3) var(--space-6) 0' }}>
              {departmentError}
            </div>
          )}

          <form onSubmit={handleSaveDepartment}>
            <div className="sac-department-modal-body">
              <label>
                <span>{form.department || record?.department ? 'Novo setor *' : 'Setor *'}</span>
                <select
                  value={targetDepartment}
                  onChange={e => setTargetDepartment(e.target.value)}
                  required
                  disabled={savingDepartment}
                >
                  <option value="">Selecione o setor</option>
                  {(departments || []).map(dept => (
                    <option key={dept} value={dept}>{dept}</option>
                  ))}
                </select>
              </label>

              <label>
                <span>Justificativa da {form.department || record?.department ? 'alteração' : 'definição'}</span>
                <textarea
                  value={departmentReason}
                  maxLength={2000}
                  placeholder={form.department || record?.department ? 'Motivo da transferência ou alteração...' : 'Motivo da classificação do setor...'}
                  onChange={e => setDepartmentReason(e.target.value)}
                  disabled={savingDepartment}
                  rows={3}
                />
              </label>

              <label className="sac-modal-confirm">
                <input
                  type="checkbox"
                  checked={departmentConfirmed}
                  onChange={e => setDepartmentConfirmed(e.target.checked)}
                  disabled={savingDepartment}
                />
                <span>Confirmo a {form.department || record?.department ? 'transferência' : 'definição'} de setor deste caso com registro de auditoria.</span>
              </label>
            </div>

            <footer className="form-footer">
              <button
                type="button"
                className="secondary"
                disabled={savingDepartment}
                onClick={() => setDepartmentModalOpen(false)}
              >
                Voltar
              </button>
              <button
                type="submit"
                className="primary"
                disabled={!departmentConfirmed || savingDepartment || !targetDepartment.trim() || targetDepartment.trim() === (form.department || record?.department)}
              >
                {savingDepartment ? 'Salvando...' : 'Confirmar alteração'}
              </button>
            </footer>
          </form>
        </section>
      </div>
    )}
  </div>;
}

