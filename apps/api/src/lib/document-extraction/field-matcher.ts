import { prisma } from '../prisma.js';
import { normalizeCatalogName } from '../../modules/catalog/catalog.schema.js';
import type { CandidateField, FormExtractionResult } from './document-extraction.types.js';
import type { InterpretedForm } from './form-interpreter.js';

export async function matchAndScoreFields(
  interpreted: InterpretedForm,
  format: 'PDF' | 'IMAGE' | 'XLSX',
  isScannedPdf = false
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
      const activeChannels = await prisma.channel.findMany({
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
          requiresReview: false,
        };
      } else {
        channelId = {
          value: '',
          confidence: 'REVIEW_REQUIRED',
          requiresReview: true,
          warning: `Canal "${interpreted.channelName.value}" não encontrado no cadastro ativo. Selecione manualmente.`,
        };
      }
    } catch {
      // Non-blocking
    }
  }

  // 3. Potential duplicate check
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

  // 4. Calculate confidence summary
  const fieldsToCheck: Array<CandidateField | undefined> = [
    interpreted.customerName,
    interpreted.orderNumber,
    interpreted.externalTicket,
    interpreted.openedAt,
    interpreted.description,
    channelId,
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

  return {
    format,
    isScannedPdf,
    externalTicket: interpreted.externalTicket,
    customerName: interpreted.customerName,
    customerContact: interpreted.customerContact,
    customerAddress: interpreted.customerAddress,
    openedAt: interpreted.openedAt,
    channelName: interpreted.channelName,
    channelId,
    orderNumber: interpreted.orderNumber,
    description: interpreted.description,
    internalNote: interpreted.internalNote,
    items: interpreted.items,
    summary: {
      totalIdentified,
      totalReviewRequired,
      totalUnidentified,
    },
    warnings: interpreted.warnings,
    existingCustomer,
    potentialDuplicate,
  };
}
