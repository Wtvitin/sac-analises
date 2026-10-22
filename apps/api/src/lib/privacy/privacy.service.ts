import { prisma } from '../prisma.js';

export type SensitiveCategory = 'CPF_CNPJ' | 'PHONE' | 'EMAIL' | 'CLINICAL' | 'SENSITIVE';

export const SENSITIVE_MASK = '***';

/**
 * Complete fixed concealment for CPF and CNPJ.
 * Returns exactly '***' when a value is present, without revealing digits, length or structure.
 * Empty or missing fields continue indicating absence of information ('').
 */
export function maskCpfCnpj(value: string | null | undefined): string {
  if (!value || typeof value !== 'string' || !value.trim()) return '';
  return SENSITIVE_MASK;
}

/**
 * Complete fixed concealment for phone numbers.
 * Returns exactly '***' when a value is present, without revealing DDD, digits or length.
 * Empty or missing fields continue indicating absence of information ('').
 */
export function maskPhone(value: string | null | undefined): string {
  if (!value || typeof value !== 'string' || !value.trim()) return '';
  return SENSITIVE_MASK;
}

/**
 * Complete fixed concealment for email addresses.
 * Returns exactly '***' when a value is present, without revealing username, @ or domain.
 * Empty or missing fields continue indicating absence of information ('').
 */
export function maskEmail(value: string | null | undefined): string {
  if (!value || typeof value !== 'string' || !value.trim()) return '';
  return SENSITIVE_MASK;
}

/**
 * Complete fixed concealment for patient clinical data and medical history.
 * Under LGPD (Art. 5º, II and Art. 11), health data and patient clinical history are sensitive personal data.
 * Returns exactly '***' when a value is present.
 */
export function maskClinicalData(value: string | null | undefined): string {
  if (!value || typeof value !== 'string' || !value.trim()) return '';
  return SENSITIVE_MASK;
}

/**
 * Complete fixed concealment for other sensitive text like addresses or professional council IDs.
 * Returns exactly '***' when a value is present.
 * Empty or missing fields continue indicating absence of information ('').
 */
export function maskGenericSensitive(value: string | null | undefined): string {
  if (!value || typeof value !== 'string' || !value.trim()) return '';
  return SENSITIVE_MASK;
}

export function detectSensitiveCategory(label: string, category?: string): SensitiveCategory | null {
  const normLabel = label.toLowerCase().trim();
  if (/cpf|cnpj/.test(normLabel)) return 'CPF_CNPJ';
  if (/telefone|celular|fone|whatsapp|tel\b/.test(normLabel)) return 'PHONE';
  if (/e-?mail/.test(normLabel)) return 'EMAIL';

  // Patient clinical and health data protection (LGPD Art. 5, II and Art. 11)
  // Strictly checks word boundaries so technical terms (e.g. 'estabilidade') are not falsely flagged.
  const isPatientHealthData = /\b(paciente|idade|sexo|g[êe]nero|alergia|doen[çc]as?|medicamentos?|cirurgias?|intercorr[êe]ncias?|comorbidades?|anamnese)\b/i.test(normLabel);

  if (isPatientHealthData) {
    return 'CLINICAL';
  }

  if (category === 'SENSITIVE' || /cro|endereço|address/.test(normLabel)) return 'SENSITIVE';
  return null;
}

export function maskValueByCategory(value: string | null | undefined, category: SensitiveCategory): string {
  if (!value || typeof value !== 'string' || !value.trim()) return '';
  return SENSITIVE_MASK;
}

/**
 * Sanitizes a document import session payload for client delivery.
 * All sensitive fields (CPF/CNPJ, phone, email, patient clinical data, address, CRO) are masked by default.
 * Raw sensitive values and raw source snippets are NEVER exposed in this sanitized payload.
 */
/**
 * Detects whether a filename quoted in a document contains personal identifying information
 * (e.g. patient name, medical record identifiers, birth date or CPF).
 */
export function hasPersonalIdentificationInFilename(filename: string): boolean {
  if (!filename || typeof filename !== 'string') return false;
  const clean = filename.trim();
  const extMatch = clean.match(/\.[a-zA-Z0-9]+$/);
  const ext = extMatch ? extMatch[0] : '';
  const base = ext ? clean.slice(0, -ext.length) : clean;

  // Direct patient or identifier keywords (handles underscores, hyphens, and word bounds)
  if (/(?:^|[^a-zA-ZÀ-ÿ0-9])(paciente|pac|cpf|rg|beneficiario|nascimento|nasc)(?:[^a-zA-ZÀ-ÿ0-9]|$)/i.test(base)) {
    return true;
  }

  // Common technical non-PII terms in filename words
  const nonPiiTerms = new Set([
    'foto', 'fotos', 'photo', 'photos', 'imagem', 'imagens', 'image', 'images', 'img',
    'produto', 'produtos', 'etiqueta', 'etiquetas', 'rotulo', 'rotulos',
    'embalagem', 'embalagens', 'radiografia', 'radiografias', 'periapical',
    'panoramica', 'panoramico', 'rx', 'raio-x', 'raiox', 'scan', 'scanner',
    'arquivo', 'documento', 'anexo', 'componente', 'componentes', 'implante',
    'implantes', 'transfer', 'transfers', 'catalogo', 'manual', 'comprovante',
    'nota', 'fiscal', 'nf', 'danfe', 'pedido', 'termo', 'contrato', 'laudo'
  ]);

  // Extract alphabetical word tokens
  const wordTokens = (base.match(/[a-zA-ZÀ-ÿ]+/g) || [])
    .map(w => w.toLowerCase())
    .filter(w => w.length >= 3);

  // If there are words, check how many are NOT non-PII technical terms
  const identifyingWords = wordTokens.filter(w => !nonPiiTerms.has(w));

  // If there are 2 or more distinct personal name words (e.g. 'Joao Batista', 'Maria Silva', 'Paciente Teste')
  if (identifyingWords.length >= 2) {
    return true;
  }

  // Combined pattern: birth date or date followed or preceded by name words
  // e.g. 16-05-2025-*-16-12-19621 or 16-12-1962-Maria
  if (/\b\d{2}[-_/.]\d{2}[-_/.]\d{4}\b/.test(base) && identifyingWords.length >= 1) {
    return true;
  }

  return false;
}

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
          isSensitive: true,
          sensitiveCategory: detected,
          // Prevent sourceSnippet from leaking the sensitive raw value
          sourceSnippet: undefined,
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
    sanitized.customerContact.value = SENSITIVE_MASK;
    sanitized.customerContact.isMasked = true;
    sanitized.customerContact.isSensitive = true;
    sanitized.customerContact.sourceSnippet = 'Contato informado no formulário (protegido por política de privacidade)';
    sanitized.customerContact.sensitiveCategory = /@/.test(raw) ? 'EMAIL' : 'PHONE';
  }

  // Sanitize customerAddress
  if (sanitized.customerAddress?.value) {
    sanitized.customerAddress.value = maskGenericSensitive(String(sanitized.customerAddress.value));
    sanitized.customerAddress.isMasked = true;
    sanitized.customerAddress.isSensitive = true;
    sanitized.customerAddress.sourceSnippet = 'Endereço informado no formulário (protegido por política de privacidade)';
    sanitized.customerAddress.sensitiveCategory = 'SENSITIVE';
  }

  // Sanitize referencedFiles: mask patient identifying details in filenames completely as '***'
  if (Array.isArray(sanitized.referencedFiles)) {
    sanitized.referencedFiles = sanitized.referencedFiles.map((rf: any, index: number) => {
      if (!rf || typeof rf.name !== 'string') return rf;
      const isSensitive = hasPersonalIdentificationInFilename(rf.name);
      if (isSensitive) {
        return {
          ...rf,
          name: SENSITIVE_MASK,
          isMasked: true,
          isSensitive: true,
          sensitiveCategory: 'CLINICAL' as const,
          fileIndex: index,
        };
      }
      return {
        ...rf,
        fileIndex: index,
        isMasked: false,
      };
    });
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
