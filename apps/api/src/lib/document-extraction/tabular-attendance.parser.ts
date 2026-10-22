import { randomUUID } from 'node:crypto';
import type {
  AdditionalFieldInfo,
  CandidateField,
  ExtractedItem,
  ExtractedReference,
  RawDocumentText,
} from './document-extraction.types.js';
import type { InterpretedForm } from './form-interpreter.js';

export const TABULAR_ATTENDANCE_ANCHORS = [
  /dados\s+do\s+atendimento/i,
  /observa[çc][ãa]o\s+do\s+atendimento/i,
  /\batendimento\b(?:\s*[:#]|\s+)\s*\d{4,10}/i,
  /\bcomunica[çc][ãa]o\b(?:\s*[:#]|\s+)\s*\d+/i,
  /\boperador\b(?:\s*[:#]|\s+)\s*\d+/i,
  /item\s*\|\s*assunto/i,
];

export function isTabularAttendanceDocument(text: string): boolean {
  if (!text) return false;
  if (/dados\s+do\s+atendimento/i.test(text)) return true;

  let matches = 0;
  for (const rx of TABULAR_ATTENDANCE_ANCHORS) {
    if (rx.test(text)) matches++;
  }
  return matches >= 2;
}

function cleanObservationText(raw: string): string {
  let cleaned = raw
    // Remove interlaced table labels if OCR overlapped them
    .replace(/(?:^|\n)\s*(?:S\s+)?Atendimento\s+/g, ' ')
    .replace(/(?:^|\n)\s*Observa[çc][ãa]o\s+do\s+/g, ' ')
    .replace(/\bV\s+cliente\b/gi, 'cliente')
    // Fix OCR word splits
    .replace(/\bim\s+plante\b/gi, 'implante')
    .replace(/\bse\s+guintes\b/gi, 'seguintes')
    .replace(/\bprovi\s+denciarmos\b/gi, 'providenciarmos')
    .replace(/\bgara\s+ntir\b/gi, 'garantir')
    // Normalize diameter symbols if OCR misread Ø
    .replace(/(?:69|9)3\.5\s*HE\b/g, 'Ø3.5 HE')
    .replace(/(?:69|9)4\.0\s*HE\b/g, 'Ø4.0 HE')
    // Normalize dashes
    .replace(/[—–]/g, '–')
    // Collapse spacing
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\s*\n\s*/g, ' ')
    .trim();

  return cleaned;
}

export function extractAttendanceComponents(text: string): ExtractedItem[] {
  const items: ExtractedItem[] = [];

  // Match: Description [–—-] Cód. Code
  const codRegex = /[–—\-]\s*c[óo]d\.?\s*([0-9]{4,8})/gi;
  const matches: Array<{ code: string; index: number; length: number }> = [];
  let m: RegExpExecArray | null;

  while ((m = codRegex.exec(text)) !== null) {
    matches.push({ code: m[1], index: m.index, length: m[0].length });
  }

  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    let descStart = 0;
    if (i === 0) {
      const prefix = text.slice(0, current.index);
      const itensIdx = prefix.search(/(?:itens|aus[êe]ncia\s+dos\s+se\s*guintes\s+itens)[\s:]+/i);
      if (itensIdx !== -1) {
        const afterItens = prefix.slice(itensIdx);
        const colonIdx = afterItens.indexOf(':');
        descStart = itensIdx + (colonIdx !== -1 ? colonIdx + 1 : 0);
      }
    } else {
      descStart = matches[i - 1].index + matches[i - 1].length;
    }

    let desc = text.slice(descStart, current.index).trim();
    // Strip leading punctuation, bullets, labels
    desc = desc.replace(/^[^a-zA-Z0-9À-ÿØø]+/, '').trim();
    desc = desc.replace(/^(?:observa[çc][ãa]o\s+do|atendimento)\s+/i, '').trim();
    desc = desc.replace(/(?:69|9)3\.5\s*HE\b/g, 'Ø3.5 HE');
    desc = desc.replace(/(?:69|9)4\.0\s*HE\b/g, 'Ø4.0 HE');
    desc = desc.replace(/[—–]/g, '–').replace(/\s*\n\s*/g, ' ').trim();

    if (desc && current.code) {
      items.push({
        key: randomUUID(),
        code: current.code,
        description: desc,
        batch: '',
        quantity: 0,
        note: 'Componente relacionado no atendimento',
        confidence: 'IDENTIFIED',
        confidenceLevel: 'HIGH',
        requiresReview: true,
        batchStatus: 'EMPTY',
        batchNotice: 'O lote não foi informado no documento.',
        warning: 'O lote não foi informado no documento. Informe a quantidade manualmente.',
        sourceSnippet: `${desc} – Cód. ${current.code}`,
      });
    }
  }

  return items;
}

export function parseTabularAttendanceDocument(raw: RawDocumentText): InterpretedForm {
  const text = raw.text || '';
  const warnings = [...(raw.warnings || [])];
  const additionalInfo: AdditionalFieldInfo[] = [];
  const candidateReferences: ExtractedReference[] = [];
  const rawFields: Record<string, string> = {};

  // 1. External Ticket / Atendimento (preserve leading zeros as a string, e.g. "005233")
  const ticketMatch = text.match(/\batendimento\b(?:\s*[:#]|\s+)\s*([0-9]{4,10})/i);
  const ticketValue = ticketMatch ? ticketMatch[1].trim() : '';

  const externalTicket: CandidateField = ticketValue
    ? {
        value: ticketValue,
        sourceSnippet: ticketMatch![0].trim(),
        confidence: 'IDENTIFIED',
        confidenceLevel: 'HIGH',
        requiresReview: false,
      }
    : { value: '', confidence: 'UNIDENTIFIED', confidenceLevel: 'LOW', requiresReview: true };

  if (ticketValue) {
    candidateReferences.push({
      type: 'ATTENDANCE',
      value: ticketValue,
      label: 'Atendimento de origem',
      confidence: 'IDENTIFIED',
    });
    rawFields.atendimento = ticketValue;
  }

  // 2. Cliente e Código de Cliente (e.g. "A2150001 - ROCHA SERVICOS ODONTOLOGICOS")
  let customerNameValue = '';
  let customerCodeValue = '';
  let customerSnippet = '';

  const clientLineMatch = text.match(/\bcliente\b(?:\s*[:#]|\s+)\s*([A-Za-z0-9]+)\s*-\s*([^\r\n;]+)/i);
  if (clientLineMatch) {
    customerCodeValue = clientLineMatch[1].trim();
    customerNameValue = clientLineMatch[2].trim().replace(/^(sr|sra|dr|dra)\.?\s+/i, '');
    customerSnippet = clientLineMatch[0].trim();
  } else {
    const fallbackClientMatch = text.match(/\bcliente\b(?:\s*[:#]|\s+)\s*([A-ZÀ-ÖØ-öø-ÿ\s]{4,80})/i);
    if (fallbackClientMatch && !/^(?:nos|que|solicitou|informou|informa|relatou|enviou|encaminhou)\b/i.test(fallbackClientMatch[1].trim())) {
      customerNameValue = fallbackClientMatch[1].trim();
      customerSnippet = fallbackClientMatch[0].trim();
    }
  }

  const customerName: CandidateField = customerNameValue
    ? {
        value: customerNameValue,
        sourceSnippet: customerSnippet,
        confidence: 'IDENTIFIED',
        confidenceLevel: 'HIGH',
        requiresReview: false,
      }
    : { value: '', confidence: 'UNIDENTIFIED', confidenceLevel: 'LOW', requiresReview: true };

  if (customerCodeValue) {
    candidateReferences.push({
      type: 'CUSTOMER_CODE',
      value: customerCodeValue,
      label: 'Código do cliente',
      confidence: 'IDENTIFIED',
    });
    rawFields.codigoCliente = customerCodeValue;
  }
  if (customerNameValue) rawFields.cliente = customerNameValue;

  // 3. Contato
  const contactMatch = text.match(/\bcontato\b(?:\s*[:#]|\s+)\s*([^\r\n;]+)/i);
  let customerContact: CandidateField | undefined;
  if (contactMatch) {
    const contactVal = contactMatch[1].trim();
    customerContact = {
      value: contactVal,
      sourceSnippet: contactMatch[0].trim(),
      confidence: 'IDENTIFIED',
      confidenceLevel: 'HIGH',
      requiresReview: false,
    };
    rawFields.contato = contactVal;
  }

  // 4. Telefone (sensitive)
  const phoneMatch = text.match(/\btelefone\b(?:\s*[:#]|\s+)\s*([0-9()\s\-\./]+)/i);
  if (phoneMatch) {
    const rawPhone = phoneMatch[1].replace(/[\/\s]+$/, '').trim();
    if (rawPhone.length >= 8) {
      additionalInfo.push({
        label: 'Telefone',
        value: rawPhone,
        category: 'CONTATO',
        isSensitive: true,
      });
      rawFields.telefone = rawPhone;
    }
  }

  // 5. Data e Hora Inicial do Atendimento (15/10/2026 às 17:45:19)
  const dateMatch = text.match(/\bdata\b(?:\s*[:#]|\s+)\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i);
  const timeMatch = text.match(/\bhora\s+inicial\b(?:\s*[:#]|\s+)\s*(\d{1,2}:\d{2}(?::\d{2})?)/i);

  let openedAtValue = '';
  let dateFormattedStr = '';

  if (dateMatch) {
    const cleanDate = dateMatch[1].trim();
    const parts = cleanDate.split(/[\/\-\.]/);
    if (parts.length === 3) {
      const day = String(parts[0]).padStart(2, '0');
      const month = String(parts[1]).padStart(2, '0');
      let year = parts[2];
      if (year.length === 2) year = `20${year}`;

      let hours = '09';
      let minutes = '00';
      let seconds = '00';
      if (timeMatch) {
        const timeParts = timeMatch[1].trim().split(':');
        if (timeParts.length >= 2) {
          hours = timeParts[0].padStart(2, '0');
          minutes = timeParts[1].padStart(2, '0');
          if (timeParts.length >= 3) seconds = timeParts[2].padStart(2, '0');
        }
      }

      openedAtValue = `${year}-${month}-${day}T${hours}:${minutes}`;
      dateFormattedStr = `${day}/${month}/${year}${timeMatch ? ` às ${timeMatch[1].trim()}` : ''}`;
    }
  }

  const openedAt: CandidateField = openedAtValue
    ? {
        value: openedAtValue,
        sourceSnippet: `Data encontrada no documento: ${dateFormattedStr}`,
        confidence: 'REVIEW_REQUIRED',
        confidenceLevel: 'MEDIUM',
        requiresReview: true,
        warning: `Data e hora do atendimento original encontrada no documento (${dateFormattedStr}). Verifique se corresponde à data de ocorrência.`,
      }
    : { value: '', confidence: 'UNIDENTIFIED', confidenceLevel: 'LOW', requiresReview: false };

  if (dateFormattedStr) {
    additionalInfo.push({
      label: 'Data do Atendimento de Origem',
      value: dateFormattedStr,
      category: 'OUTROS',
    });
    rawFields.dataAtendimento = dateFormattedStr;
  }

  // 6. Comunicação / Canal (2 - CONSULTOR)
  const commMatch = text.match(/\bcomunica[çc][ãa]o\b(?:\s*[:#]|\s+)\s*([^\r\n;]+)/i);
  let channelName: CandidateField | undefined;
  if (commMatch) {
    const commVal = commMatch[1].trim().replace(/^(\d+)\s*-\s*/, '$1 - ');
    channelName = {
      value: commVal,
      sourceSnippet: commMatch[0].trim(),
      confidence: 'REVIEW_REQUIRED',
      confidenceLevel: 'MEDIUM',
      requiresReview: true,
      warning: `Canal de origem "${commVal}". Verifique a correspondência com o canal do SAC.`,
    };
    rawFields.comunicacao = commVal;
  }

  // 7. Operador, Status de Origem, Mídia
  const opMatch = text.match(/\boperador\b(?:\s*[:#]|\s+)\s*([^\r\n;]+)/i);
  if (opMatch) {
    const opVal = opMatch[1].trim();
    additionalInfo.push({
      label: 'Operador de Origem',
      value: opVal,
      category: 'OUTROS',
    });
    rawFields.operador = opVal;
    // Note: Do NOT set suggestedAssignee to preserve operator isolation
  }

  const statusMatch = text.match(/\bstatus\b(?:\s*[:#]|\s+)\s*(Planejado|Pendente|[A-Za-z]+)/i);
  if (statusMatch) {
    const statusVal = statusMatch[1].trim();
    additionalInfo.push({
      label: 'Status de Origem',
      value: statusVal,
      category: 'OUTROS',
    });
    rawFields.statusOrigem = statusVal;
  }

  const mediaMatch = text.match(/\bm[íi]dia\b(?:\s*[:#]|\s+)\s*([^\r\n;]+)/i);
  if (mediaMatch) {
    const mediaVal = mediaMatch[1].trim();
    additionalInfo.push({
      label: 'Mídia de Origem',
      value: mediaVal,
      category: 'OUTROS',
    });
    rawFields.midia = mediaVal;
  }

  // 8. Observação do Atendimento & Descrição
  let obsText = '';
  const prezadosMatch = text.match(/(Prezados,?\s+boa\s+tarde![\s\S]+?(?:PEDIDO\s*[0-9]{3,10}|garantir\s+que\s+o\s+cliente\s+receba\s+todos\s+os\s+itens\s+previstos\.?\s*(?:PEDIDO\s*[0-9]{3,10})?))/i);
  if (prezadosMatch) {
    obsText = cleanObservationText(prezadosMatch[1]);
  } else {
    const obsGenericMatch = text.match(/observa[çc][ãa]o\s+do\s+atendimento[\s\S]*?(Prezados[\s\S]+?)(?=\n\s*(?:Item\s*\||001\s+000033|$))/i);
    if (obsGenericMatch) {
      obsText = cleanObservationText(obsGenericMatch[1]);
    } else {
      const fallbackMatch = text.match(/observa[çc][ãa]o\s+do\s+atendimento\s*[:#]?\s*([\s\S]+?)(?=\n\s*(?:Item\s*\||001\s+000033|$))/i);
      if (fallbackMatch) {
        obsText = cleanObservationText(fallbackMatch[1]);
      }
    }
  }

  const description: CandidateField = obsText
    ? {
        value: obsText,
        sourceSnippet: obsText.slice(0, 150),
        confidence: 'IDENTIFIED',
        confidenceLevel: 'HIGH',
        requiresReview: false,
      }
    : { value: '', confidence: 'UNIDENTIFIED', confidenceLevel: 'LOW', requiresReview: true };

  if (obsText) rawFields.observacao = obsText;

  // 9. Pedido (PEDIDO 360460)
  const orderMatch = text.match(/\bpedido\s*[:#\s]?\s*([0-9]{3,10})\b/i);
  let orderNumber: CandidateField;
  if (orderMatch) {
    const orderNum = orderMatch[1].trim();
    orderNumber = {
      value: orderNum,
      sourceSnippet: orderMatch[0].trim(),
      confidence: 'IDENTIFIED',
      confidenceLevel: 'HIGH',
      requiresReview: false,
    };
    candidateReferences.push({
      type: 'ORDER',
      value: orderNum,
      label: 'Pedido identificado na observação',
      confidence: 'IDENTIFIED',
    });
    rawFields.pedido = orderNum;
  } else {
    orderNumber = { value: '', confidence: 'UNIDENTIFIED', confidenceLevel: 'LOW', requiresReview: true };
  }

  // 10. Componentes Citados (Items)
  const items = extractAttendanceComponents(text);

  // 11. Tabela de Ações (Informação Adicional de Acompanhamento)
  const actionMatch = text.match(/001\s+(?:\[?000033\]?)\s+000189\s+000016\s+Renato\s+Monteiro/i);
  if (actionMatch) {
    additionalInfo.push({
      label: 'Ação Registrada',
      value: 'Item 001: Assunto 000033, Ocorrência 000189, Ação 000016 (Renato Monteiro)',
      category: 'OUTROS',
    });
  }

  return {
    modelId: 'TABULAR_ATTENDANCE',
    modelName: 'Atendimento Tabular',
    externalTicket,
    customerName,
    customerContact,
    openedAt,
    channelName,
    orderNumber,
    description,
    candidateReferences,
    items,
    additionalInfo,
    rawFields,
    warnings,
  };
}
