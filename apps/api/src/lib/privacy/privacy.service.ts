import { prisma } from '../prisma.js';

export type SensitiveCategory = 'CPF_CNPJ' | 'PHONE' | 'EMAIL' | 'SENSITIVE';

/**
 * Deterministic, privacy-preserving masking for CPF (11 digits) and CNPJ (14 digits).
 */
export function maskCpfCnpj(value: string | null | undefined): string {
  if (!value) return '';
  const digits = value.replace(/\D/g, '');
  if (digits.length === 11) {
    // CPF: ***.***.789-**
    return `***.***.${digits.slice(6, 9)}-**`;
  }
  if (digits.length === 14) {
    // CNPJ: **.***.***/0001-**
    return `**.***.***/${digits.slice(8, 12)}-**`;
  }
  // Fallback for partial/irregular document text
  if (value.length <= 6) return '***';
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

/**
 * Deterministic masking for Brazilian and international phone numbers.
 */
export function maskPhone(value: string | null | undefined): string {
  if (!value) return '';
  const digits = value.replace(/\D/g, '');
  if (digits.length >= 10) {
    const ddd = digits.slice(0, 2);
    const last4 = digits.slice(-4);
    return `(${ddd}) *****-${last4}`;
  }
  if (value.length <= 4) return '****';
  return `${value.slice(0, 2)}****${value.slice(-2)}`;
}

/**
 * Deterministic masking for e-mail addresses (e.g., j***a@example.com).
 */
export function maskEmail(value: string | null | undefined): string {
  if (!value || typeof value !== 'string') return '';
  const parts = value.trim().split('@');
  if (parts.length !== 2) return '***@***';
  const [local, domain] = parts;
  if (!local || !domain) return '***@***';

  const maskedLocal = local.length <= 2
    ? `${local[0]}*`
    : `${local[0]}***${local[local.length - 1]}`;

  return `${maskedLocal}@${domain}`;
}

/**
 * Generic masking for other sensitive text like CRO/UF or complete street addresses.
 */
export function maskGenericSensitive(value: string | null | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (trimmed.length <= 4) return '****';
  return `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`;
}

export function detectSensitiveCategory(label: string, category?: string): SensitiveCategory | null {
  const normLabel = label.toLowerCase().trim();
  if (/cpf|cnpj/.test(normLabel)) return 'CPF_CNPJ';
  if (/telefone|celular|fone|whatsapp|tel\b/.test(normLabel)) return 'PHONE';
  if (/e-?mail/.test(normLabel)) return 'EMAIL';
  if (category === 'SENSITIVE' || /cro|endereço|address/.test(normLabel)) return 'SENSITIVE';
  return null;
}

export function maskValueByCategory(value: string, category: SensitiveCategory): string {
  switch (category) {
    case 'CPF_CNPJ':
      return maskCpfCnpj(value);
    case 'PHONE':
      return maskPhone(value);
    case 'EMAIL':
      return maskEmail(value);
    case 'SENSITIVE':
      return maskGenericSensitive(value);
  }
}

/**
 * Sanitizes a document import session payload for client delivery.
 * All sensitive fields (CPF/CNPJ, phone, email, address, CRO) are masked by default.
 * Raw sensitive values are NEVER exposed in this sanitized payload.
 */
export function sanitizeDocumentImportPayload(extractedData: any): any {
  if (!extractedData || typeof extractedData !== 'object') return extractedData;

  const sanitized = JSON.parse(JSON.stringify(extractedData));

  // Sanitize additionalInfo items
  if (Array.isArray(sanitized.additionalInfo)) {
    sanitized.additionalInfo = sanitized.additionalInfo.map((info: any, index: number) => {
      const detected = detectSensitiveCategory(info.label || '', info.category);
      if (detected) {
        return {
          ...info,
          fieldIndex: index,
          value: maskValueByCategory(info.value || '', detected),
          isMasked: true,
          sensitiveCategory: detected,
        };
      }
      return {
        ...info,
        fieldIndex: index,
        isMasked: false,
      };
    });
  }

  // Sanitize customerContact
  if (sanitized.customerContact?.value) {
    const raw = String(sanitized.customerContact.value);
    if (/@/.test(raw)) {
      sanitized.customerContact.value = maskEmail(raw);
      sanitized.customerContact.isMasked = true;
    } else {
      sanitized.customerContact.value = maskPhone(raw);
      sanitized.customerContact.isMasked = true;
    }
  }

  // Sanitize customerAddress
  if (sanitized.customerAddress?.value) {
    sanitized.customerAddress.value = maskGenericSensitive(String(sanitized.customerAddress.value));
    sanitized.customerAddress.isMasked = true;
  }

  return sanitized;
}

/**
 * Records an audit log when an administrator reveals a sensitive field.
 * CRITICAL RULE: The actual sensitive value is NEVER stored in the audit event.
 */
export async function logSensitiveDataRevealAudit(params: {
  actorId: string;
  resourceType: 'DOCUMENT_IMPORT' | 'SAC_RECORD' | 'CUSTOMER';
  resourceId: string;
  category: SensitiveCategory;
  fieldPath?: string;
}): Promise<void> {
  const { actorId, resourceType, resourceId, category, fieldPath } = params;

  await prisma.adminAudit.create({
    data: {
      type: 'SENSITIVE_DATA_REVEALED',
      actorId,
      targetUserId: actorId,
      metadata: {
        resourceType,
        resourceId,
        category,
        fieldPath,
        revealedAt: new Date().toISOString(),
      },
    },
  });
}
