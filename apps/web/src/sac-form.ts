export type PriorityValue = '' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type SacItemForm = { key: string; code: string; description: string; batch: string; quantity: string; note: string };
export type SacFormValues = {
  customerName: string; orderNumber: string; externalTicket: string; channelId: string;
  openedAt: string; reasonId: string; subreasonId: string; priority: PriorityValue;
  description: string; internalNote: string; assigneeId: string; dueDate: string;
  identifiedCause: string; responsibleArea: string; correctiveAction: string; items: SacItemForm[];
};

export type SacFormErrors = Partial<Record<Exclude<keyof SacFormValues, 'items'> | `item-${number}`, string>>;

export const MAX_FILES = 5;
export const MAX_FILE_SIZE = 10 * 1024 * 1024;
export const ACCEPTED_FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];

function pad(value: number) { return String(value).padStart(2, '0'); }
export function toLocalDateTimeInput(value = new Date()) {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

export function createEmptySacForm(): SacFormValues {
  return { customerName: '', orderNumber: '', externalTicket: '', channelId: '', openedAt: toLocalDateTimeInput(), reasonId: '', subreasonId: '', priority: '', description: '', internalNote: '', assigneeId: '', dueDate: '', identifiedCause: '', responsibleArea: '', correctiveAction: '', items: [] };
}

export function createEmptyItem(): SacItemForm {
  return { key: crypto.randomUUID(), code: '', description: '', batch: '', quantity: '', note: '' };
}

export function validateSacForm(form: SacFormValues): SacFormErrors {
  const errors: SacFormErrors = {};
  if (form.customerName.trim().length < 2) errors.customerName = 'Informe o cliente.';
  if (!form.orderNumber.trim()) errors.orderNumber = 'Informe o número do pedido.';
  if (!form.channelId) errors.channelId = 'Selecione um canal.';
  if (!form.openedAt || Number.isNaN(new Date(form.openedAt).getTime())) errors.openedAt = 'Informe uma data de abertura válida.';
  if (!form.reasonId) errors.reasonId = 'Selecione um motivo.';
  if (!form.priority) errors.priority = 'Selecione a prioridade.';
  if (form.description.trim().length < 10) errors.description = 'Informe ao menos 10 caracteres.';
  if (!form.dueDate) errors.dueDate = 'Informe o prazo de resolução.';
  else if (form.openedAt && new Date(`${form.dueDate}T23:59:59`).getTime() < new Date(form.openedAt).getTime()) errors.dueDate = 'O prazo não pode ser anterior à abertura.';
  form.items.forEach((item, index) => {
    if (!item.code.trim() || !item.description.trim() || !item.quantity || Number(item.quantity) <= 0) errors[`item-${index}`] = 'Informe código, descrição e quantidade maior que zero.';
  });
  return errors;
}

export function validateAttachments(files: Array<Pick<File, 'name' | 'size' | 'type'>>, existingCount = 0) {
  if (existingCount + files.length > MAX_FILES) return `Mantenha no máximo ${MAX_FILES} evidências por registro.`;
  const invalidType = files.find(file => !ACCEPTED_FILE_TYPES.includes(file.type));
  if (invalidType) return `${invalidType.name}: formato não permitido.`;
  const invalidSize = files.find(file => file.size <= 0 || file.size > MAX_FILE_SIZE);
  if (invalidSize) return `${invalidSize.name}: o arquivo deve possuir até 10 MB.`;
  return '';
}

export function sacFormPayload(form: SacFormValues, allowDuplicateExternalTicket: boolean, updatedAt?: string) {
  return {
    customerName: form.customerName, orderNumber: form.orderNumber, externalTicket: form.externalTicket,
    channelId: form.channelId, openedAt: new Date(form.openedAt).toISOString(), reasonId: form.reasonId,
    subreasonId: form.subreasonId || undefined, priority: form.priority, description: form.description,
    internalNote: form.internalNote, assigneeId: form.assigneeId || undefined,
    dueAt: new Date(`${form.dueDate}T23:59:59`).toISOString(), identifiedCause: form.identifiedCause,
    responsibleArea: form.responsibleArea, correctiveAction: form.correctiveAction,
    items: form.items.map(({ key: _key, ...item }) => ({ ...item, quantity: Number(item.quantity) })),
    allowDuplicateExternalTicket, ...(updatedAt ? { updatedAt } : {}),
  };
}

export function hasUnsavedSacChanges(form: SacFormValues, initial: SacFormValues, files: File[]) {
  return files.length > 0 || JSON.stringify(form) !== JSON.stringify(initial);
}
