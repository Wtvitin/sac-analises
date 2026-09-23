import { prisma } from '../prisma.js';
import { normalizeCatalogName } from '../../modules/catalog/catalog.schema.js';
import type { CandidateField, FormExtractionResult } from './document-extraction.types.js';
import type { InterpretedForm } from './form-interpreter.js';

export async function matchAndScoreFields(
  interpreted: InterpretedForm,
  format: 'PDF' | 'IMAGE' | 'XLSX',
  isScannedPdf = false,
  catalogOverride?: {
    reasons?: Array<{ id: string; name: string; normalizedName?: string }>;
    channels?: Array<{ id: string; name: string; normalizedName?: string }>;
  }
): Promise<FormExtractionResult> {
  let existingCustomer: { id: string; name: string } | null = null;

  // 1. Existing customer lookup
  if (interpreted.customerName.value) {
    try {
      const normalized = normalizeCatalogName(interpreted.customerName.value);
      const customer = await prisma.customer.findFirst({
        where: { normalizedName: normalized, archivedAt: null },
        select: { id: true, name: true },
      });
      if (customer) {
        existingCustomer = customer;
      }
    } catch {
      // Non-blocking in isolated or test context
    }
  }

  // 2. Channel lookup and correlation
  let channelId: CandidateField | undefined;
  if (interpreted.channelName?.value) {
    try {
      const activeChannels = catalogOverride?.channels
        ? catalogOverride.channels.map(c => ({ ...c, normalizedName: c.normalizedName || normalizeCatalogName(c.name) }))
        : await prisma.channel.findMany({
            where: { active: true },
            select: { id: true, name: true, normalizedName: true },
          });
      const normInput = normalizeCatalogName(interpreted.channelName.value);
      const matched = activeChannels.find(c =>
        c.normalizedName === normInput ||
        normInput.includes(c.normalizedName) ||
        c.normalizedName.includes(normInput)
      );

      if (matched) {
        channelId = {
          value: matched.id,
          sourceSnippet: `Correspondente ao canal cadastrado "${matched.name}"`,
          confidence: 'IDENTIFIED',
          confidenceLevel: 'HIGH',
          requiresReview: false,
        };
      } else {
        channelId = {
          value: '',
          confidence: 'REVIEW_REQUIRED',
          confidenceLevel: 'MEDIUM',
          requiresReview: true,
          warning: `Canal "${interpreted.channelName.value}" não encontrado no cadastro ativo. Selecione manualmente.`,
        };
      }
    } catch {
      // Non-blocking
    }
  }

  // 3. Reason lookup and suggestion (e.g. from "Qual foi o ocorrido?")
  let suggestedReason: CandidateField | undefined;
  let suggestedSubreason: CandidateField | undefined;
  if (interpreted.occurrenceReasonText) {
    try {
      const activeReasons = catalogOverride?.reasons
        ? catalogOverride.reasons.map(r => ({ ...r, normalizedName: r.normalizedName || normalizeCatalogName(r.name) }))
        : await prisma.reason.findMany({
            where: { active: true },
            select: { id: true, name: true, normalizedName: true },
          });
      const normReasonInput = normalizeCatalogName(interpreted.occurrenceReasonText);
      const matchedReason = activeReasons.find(r =>
        r.normalizedName === normReasonInput ||
        normReasonInput.includes(r.normalizedName) ||
        r.normalizedName.includes(normReasonInput)
      );

      if (matchedReason) {
        suggestedReason = {
          value: matchedReason.id,
          sourceSnippet: `Correspondente ao motivo cadastrado "${matchedReason.name}" ("${interpreted.occurrenceReasonText}")`,
          confidence: 'IDENTIFIED',
          confidenceLevel: 'HIGH',
          requiresReview: false,
        };
      }
    } catch {
      // Non-blocking
    }
  }

  // 4. Potential duplicate check
  let potentialDuplicate: { found: boolean; ticket?: string; reason?: string } | null = null;

  try {
    if (interpreted.externalTicket.value) {
      const dup = await prisma.sacRecord.findFirst({
        where: { externalTicket: interpreted.externalTicket.value, archivedAt: null },
        select: { ticket: true },
      });
      if (dup) {
        potentialDuplicate = {
          found: true,
          ticket: dup.ticket,
          reason: `Protocolo externo "${interpreted.externalTicket.value}" já cadastrado no chamado ${dup.ticket}.`,
        };
      }
    }

    if (!potentialDuplicate && interpreted.orderNumber.value) {
      const dupOrder = await prisma.sacRecord.findFirst({
        where: { orderNumber: interpreted.orderNumber.value, archivedAt: null },
        select: { ticket: true },
      });
      if (dupOrder) {
        potentialDuplicate = {
          found: true,
          ticket: dupOrder.ticket,
          reason: `Número do pedido "${interpreted.orderNumber.value}" já possui chamado aberto (${dupOrder.ticket}).`,
        };
      }
    }
  } catch {
    // Non-blocking
  }

  // 5. Calculate confidence summary
  const fieldsToCheck: Array<CandidateField | undefined> = [
    interpreted.customerName,
    interpreted.orderNumber,
    interpreted.externalTicket,
    interpreted.openedAt,
    interpreted.description,
    channelId,
    suggestedReason,
  ];

  let totalIdentified = 0;
  let totalReviewRequired = 0;
  let totalUnidentified = 0;

  for (const f of fieldsToCheck) {
    if (!f || f.confidence === 'UNIDENTIFIED') {
      totalUnidentified++;
    } else if (f.confidence === 'REVIEW_REQUIRED') {
      totalReviewRequired++;
    } else if (f.confidence === 'IDENTIFIED') {
      totalIdentified++;
    }
  }

  // Helper to ensure CandidateField is always safe and populated
  const createEmptyCandidate = (sourceSnippet = '', warning?: string): CandidateField => ({
    value: '',
    sourceSnippet,
    confidence: 'UNIDENTIFIED',
    confidenceLevel: 'LOW',
    warning,
    requiresReview: false,
  });

  const ensureCandidateField = (field?: CandidateField): CandidateField => {
    if (!field) return createEmptyCandidate();
    return {
      ...field,
      confidence: field.confidence || 'UNIDENTIFIED',
      confidenceLevel:
        field.confidenceLevel ||
        (field.confidence === 'IDENTIFIED' ? 'HIGH' : field.confidence === 'REVIEW_REQUIRED' ? 'MEDIUM' : 'LOW'),
    };
  };

  const ensureOptionalCandidate = (field?: CandidateField): CandidateField | undefined => {
    if (!field) return undefined;
    return ensureCandidateField(field);
  };

  return {
    format,
    isScannedPdf,
    modelId: interpreted?.modelId || 'KEY_VALUE_FORM',
    modelName: interpreted?.modelName || 'Formulário Padrão',
    externalTicket: ensureCandidateField(interpreted?.externalTicket),
    customerName: ensureCandidateField(interpreted?.customerName),
    customerContact: ensureOptionalCandidate(interpreted?.customerContact),
    customerAddress: ensureOptionalCandidate(interpreted?.customerAddress),
    openedAt: ensureCandidateField(interpreted?.openedAt),
    channelName: ensureOptionalCandidate(interpreted?.channelName),
    channelId: ensureOptionalCandidate(channelId),
    orderNumber: ensureCandidateField(interpreted?.orderNumber),
    description: ensureCandidateField(interpreted?.description),
    internalNote: ensureOptionalCandidate(interpreted?.internalNote),
    suggestedReason: ensureOptionalCandidate(suggestedReason),
    suggestedSubreason: ensureOptionalCandidate(suggestedSubreason),
    invoiceNumber: ensureOptionalCandidate(interpreted?.invoiceNumber),
    items: (interpreted?.items || []).map(it => ({
      ...it,
      confidenceLevel: it?.confidenceLevel || (it?.confidence === 'IDENTIFIED' ? 'HIGH' : 'MEDIUM'),
    })),
    additionalInfo: interpreted?.additionalInfo || [],
    referencedFiles: interpreted?.referencedFiles || [],
    summary: {
      totalIdentified,
      totalReviewRequired,
      totalUnidentified,
    },
    warnings: interpreted?.warnings || [],
    existingCustomer,
    potentialDuplicate,
  };
}
