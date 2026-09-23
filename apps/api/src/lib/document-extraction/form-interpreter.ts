import type { CandidateField, ExtractedItem, RawDocumentText } from './document-extraction.types.js';

export interface InterpretedForm {
  externalTicket: CandidateField;
  customerName: CandidateField;
  customerContact?: CandidateField;
  customerAddress?: CandidateField;
  openedAt: CandidateField;
  channelName?: CandidateField;
  orderNumber: CandidateField;
  description: CandidateField;
  internalNote?: CandidateField;
  suggestedAssignee?: CandidateField;
  items: ExtractedItem[];
  rawFields: Record<string, string>;
  warnings: string[];
}

function extractLabelValue(text: string, patterns: RegExp[]): { value: string; snippet: string } | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const val = match[1].trim().replace(/\s+/g, ' ');
      if (val.length > 0) {
        return { value: val, snippet: match[0].trim() };
      }
    }
  }
  return null;
}

function parseBrazilianDate(dateStr: string, timeStr?: string): string {
  try {
    const cleanDate = dateStr.trim();
    const parts = cleanDate.split(/[\/\-\.]/);
    if (parts.length === 3) {
      let day = parseInt(parts[0], 10);
      let month = parseInt(parts[1], 10);
      let year = parseInt(parts[2], 10);
      if (year < 100) year += 2000;

      // Handle YYYY-MM-DD if in that order
      if (parts[0].length === 4) {
        year = parseInt(parts[0], 10);
        month = parseInt(parts[1], 10);
        day = parseInt(parts[2], 10);
      }

      let hours = 9;
      let minutes = 0;
      if (timeStr) {
        const timeParts = timeStr.trim().split(':');
        if (timeParts.length >= 2) {
          hours = parseInt(timeParts[0], 10) || 0;
          minutes = parseInt(timeParts[1], 10) || 0;
        }
      }

      const d = new Date(year, month - 1, day, hours, minutes);
      if (!isNaN(d.getTime())) {
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }
    }
  } catch {
    // fallback
  }
  return '';
}

function detectOrderNumbers(text: string, externalTicket?: string): { numbers: string[]; snippets: string[] } {
  const matches: string[] = [];
  const snippets: string[] = [];

  // Patterns for order references: "pedido 12345", "pv: 9876", "nº pedido 5544"
  const regex = /\b(?:pedido|pv|ped\.?|n[ºo°]?\s*pedido)\s*[:#\s]?\s*([0-9]{3,12})\b/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const num = match[1].trim();
    // Do not confuse with the external ticket if they are identical and labeled as ticket
    if (!matches.includes(num)) {
      matches.push(num);
      snippets.push(match[0].trim());
    }
  }

  return { numbers: matches, snippets };
}

export function interpretDocumentText(raw: RawDocumentText): InterpretedForm {
  const text = raw.text;
  const warnings = [...raw.warnings];
  const rawFields: Record<string, string> = {};

  // 1. External Ticket / Atendimento
  const ticketFound = extractLabelValue(text, [
    /\b(?:atendimento|protocolo|n[ºo°]?\s*atendimento)\s*[:#\s]?\s*([A-Za-z0-9\-_/]+)/i,
    /\b(?:ticket|chamado)\s*[:#\s]?\s*([A-Za-z0-9\-_/]+)/i,
  ]);
  const externalTicket: CandidateField = ticketFound
    ? {
        value: ticketFound.value,
        sourceSnippet: ticketFound.snippet,
        confidence: 'IDENTIFIED',
        requiresReview: false,
      }
    : { value: '', confidence: 'UNIDENTIFIED', requiresReview: false };

  // 2. Cliente
  const clientFound = extractLabelValue(text, [
    /\b(?:cliente|nome\s+do\s+cliente|raz[ãa]o\s+social)\s*[:#\s]?\s*([^\r\n;]+)/i,
  ]);
  const customerName: CandidateField = clientFound
    ? {
        value: clientFound.value.replace(/^(sr|sra|dr|dra)\.?\s+/i, ''),
        sourceSnippet: clientFound.snippet,
        confidence: 'IDENTIFIED',
        requiresReview: false,
      }
    : { value: '', confidence: 'UNIDENTIFIED', requiresReview: true };

  // 3. Contato e Endereço
  const contactFound = extractLabelValue(text, [/\b(?:contato|respons[áa]vel)\s*[:#\s]?\s*([^\r\n;]+)/i]);
  const phoneFound = extractLabelValue(text, [/\b(?:telefone|fone|celular|whatsapp|tel)\s*[:#\s]?\s*([0-9()\s\-\.]+)/i]);
  const cityFound = extractLabelValue(text, [/\b(?:cidade|munic[íi]pio)\s*[:#\s]?\s*([^\r\n;]+)/i]);
  const addressFound = extractLabelValue(text, [/\b(?:endere[çc]o|rua|logradouro)\s*[:#\s]?\s*([^\r\n;]+)/i]);
  const neighborhoodFound = extractLabelValue(text, [/\b(?:bairro)\s*[:#\s]?\s*([^\r\n;]+)/i]);

  let customerContact: CandidateField | undefined;
  if (contactFound || phoneFound) {
    const parts = [contactFound?.value, phoneFound?.value ? `Tel: ${phoneFound.value}` : ''].filter(Boolean);
    customerContact = {
      value: parts.join(' - '),
      sourceSnippet: [contactFound?.snippet, phoneFound?.snippet].filter(Boolean).join(' | '),
      confidence: 'IDENTIFIED',
      requiresReview: false,
    };
  }

  let customerAddress: CandidateField | undefined;
  if (addressFound || cityFound || neighborhoodFound) {
    const parts = [addressFound?.value, neighborhoodFound?.value, cityFound?.value].filter(Boolean);
    customerAddress = {
      value: parts.join(', '),
      sourceSnippet: [addressFound?.snippet, cityFound?.snippet].filter(Boolean).join(' | '),
      confidence: 'IDENTIFIED',
      requiresReview: false,
    };
  }

  // 4. Data e Hora
  const dateFound = extractLabelValue(text, [
    /\b(?:data\s+do\s+atendimento|data\s+abertura|data)\s*[:#\s]?\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
  ]);
  const timeFound = extractLabelValue(text, [
    /\b(?:hora\s+inicial|hora\s+abertura|hor[áa]rio|hora)\s*[:#\s]?\s*(\d{1,2}:\d{2})/i,
  ]);

  let parsedOpenedAt = '';
  if (dateFound) {
    parsedOpenedAt = parseBrazilianDate(dateFound.value, timeFound?.value);
  }
  const openedAt: CandidateField = parsedOpenedAt
    ? {
        value: parsedOpenedAt,
        sourceSnippet: `${dateFound?.snippet}${timeFound ? ' ' + timeFound.snippet : ''}`.trim(),
        confidence: 'IDENTIFIED',
        requiresReview: false,
      }
    : { value: '', confidence: 'UNIDENTIFIED', requiresReview: false };

  // 5. Canal / Comunicação
  const channelFound = extractLabelValue(text, [
    /\b(?:comunica[çc][ãa]o|canal|meio\s+de\s+contato|m[íi]dia)\s*[:#\s]?\s*([^\r\n;]+)/i,
  ]);
  let channelName: CandidateField | undefined;
  if (channelFound) {
    channelName = {
      value: channelFound.value,
      sourceSnippet: channelFound.snippet,
      confidence: 'REVIEW_REQUIRED',
      requiresReview: true,
      warning: 'Verifique a correspondência com o canal do SAC.',
    };
  }

  // 6. Observação / Descrição
  const descFound = extractLabelValue(text, [
    /\b(?:observa[çc][ãa]o\s+do\s+atendimento|ocorr[êe]ncia|motivo\s+relatado|descri[çc][ãa]o)\s*[:#\s]?\s*([\s\S]+?)(?=\n\s*(?:itens|tabela|produto|a[çc][ãa]o|respons[áa]vel|execu[çc][ãa]o|$))/i,
    /\b(?:observa[çc][ãa]o|assunto)\s*[:#\s]?\s*([^\r\n;]+)/i,
  ]);
  const description: CandidateField = descFound
    ? {
        value: descFound.value.slice(0, 5000),
        sourceSnippet: descFound.snippet.slice(0, 150),
        confidence: 'IDENTIFIED',
        requiresReview: false,
      }
    : { value: '', confidence: 'UNIDENTIFIED', requiresReview: true };

  // 7. Order Number Detection (Label or Free text)
  // First check explicit label
  const directOrderFound = extractLabelValue(text, [
    /\b(?:n[ºo°]?\s*do\s*pedido|n[ºo°]?\s*pedido|pedido\s*n[ºo°]?|pedido)\s*[:#]\s*([0-9A-Za-z\-_]+)/i,
  ]);

  let orderNumber: CandidateField;
  if (directOrderFound) {
    orderNumber = {
      value: directOrderFound.value,
      sourceSnippet: directOrderFound.snippet,
      confidence: 'IDENTIFIED',
      requiresReview: false,
    };
  } else {
    // Search in free text / description
    const detected = detectOrderNumbers(text, externalTicket.value);
    if (detected.numbers.length === 1) {
      orderNumber = {
        value: detected.numbers[0],
        sourceSnippet: `Identificado no trecho: "${detected.snippets[0]}"`,
        confidence: 'REVIEW_REQUIRED',
        requiresReview: true,
        warning: 'Número de pedido localizado no texto. Confirme se é o pedido correto.',
      };
    } else if (detected.numbers.length > 1) {
      orderNumber = {
        value: detected.numbers[0],
        sourceSnippet: `Múltiplos pedidos encontrados: ${detected.numbers.join(', ')}`,
        confidence: 'REVIEW_REQUIRED',
        requiresReview: true,
        warning: `Múltiplos números de pedido encontrados no texto (${detected.numbers.join(', ')}). Selecione o correto.`,
      };
    } else {
      orderNumber = {
        value: '',
        confidence: 'UNIDENTIFIED',
        requiresReview: true,
        warning: 'Número do pedido não identificado. Preencha manualmente.',
      };
    }
  }

  // 8. Internal Note (collect extra details like Contact, City, Address, Operador)
  const operatorFound = extractLabelValue(text, [/\b(?:operador|atendente)\s*[:#\s]?\s*([^\r\n;]+)/i]);
  const noteParts: string[] = [];
  if (operatorFound) noteParts.push(`Operador original: ${operatorFound.value}`);
  if (customerContact?.value) noteParts.push(`Contato: ${customerContact.value}`);
  if (customerAddress?.value) noteParts.push(`Localização: ${customerAddress.value}`);

  let internalNote: CandidateField | undefined;
  if (noteParts.length > 0) {
    internalNote = {
      value: noteParts.join(' | '),
      confidence: 'IDENTIFIED',
      requiresReview: false,
    };
  }

  // 9. Items extraction
  const items: ExtractedItem[] = [];

  // Check structured tableData if provided (e.g. from XLSX)
  if (raw.tableData && raw.tableData.length > 0) {
    raw.tableData.forEach((row, idx) => {
      const codeKey = Object.keys(row).find(k => /c[óo]digo|sku|item|cod/i.test(k));
      const descKey = Object.keys(row).find(k => /descri|produto|nome/i.test(k));
      const batchKey = Object.keys(row).find(k => /lote|batch/i.test(k));
      const qtyKey = Object.keys(row).find(k => /qtd|quantidade|quant/i.test(k));
      const noteKey = Object.keys(row).find(k => /obs|observa|a[çc][ãa]o/i.test(k));

      const code = codeKey ? row[codeKey]?.trim() || `ITEM-${idx + 1}` : `ITEM-${idx + 1}`;
      const desc = descKey ? row[descKey]?.trim() : '';
      const batch = batchKey ? row[batchKey]?.trim() : '';
      const rawQty = qtyKey ? parseFloat(row[qtyKey]?.replace(',', '.')) : 1;
      const quantity = isNaN(rawQty) || rawQty <= 0 ? 1 : rawQty;
      const note = noteKey ? row[noteKey]?.trim() : '';

      if (desc || code !== `ITEM-${idx + 1}`) {
        items.push({
          key: `import-item-${idx}`,
          code,
          description: desc || 'Item importado do formulário',
          batch,
          quantity,
          note,
          confidence: 'IDENTIFIED',
        });
      }
    });
  }

  // If no items extracted from tableData, inspect text for item lines
  if (items.length === 0) {
    const itemPattern = /(?:^|\n)\s*(?:produto|item|sku)\s*[:#\-]\s*([^\r\n;]+)/gi;
    let itemMatch: RegExpExecArray | null;
    let itemIndex = 0;

    while ((itemMatch = itemPattern.exec(text)) !== null) {
      const val = itemMatch[1].trim();
      if (val.length > 1) {
        items.push({
          key: `import-item-${itemIndex}`,
          code: `SKU-${itemIndex + 1}`,
          description: val,
          batch: '',
          quantity: 1,
          note: 'Identificado no texto',
          confidence: 'REVIEW_REQUIRED',
        });
        itemIndex++;
      }
    }
  }

  return {
    externalTicket,
    customerName,
    customerContact,
    customerAddress,
    openedAt,
    channelName,
    orderNumber,
    description,
    internalNote,
    items,
    rawFields,
    warnings,
  };
}
