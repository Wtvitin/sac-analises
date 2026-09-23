import type {
  AdditionalFieldInfo,
  CandidateField,
  ExtractedItem,
  RawDocumentText,
  ReferencedDocumentFile,
} from './document-extraction.types.js';
import type { InterpretedForm } from './form-interpreter.js';

export const OUTLOOK_FORMS_ANCHORS = [
  /nome\s+do\s+profissional/i,
  /c[óo]digo\s+do\s+produto/i,
  /descri[çc][ãa]o\s+do\s+produto/i,
  /(?:n[úu]mero\s+do\s+lote|lote)/i,
  /descri[çc][ãa]o\s+da\s+ocorr[êe]ncia/i,
  /qual\s+foi\s+o\s+ocorrido\??/i,
  /(?:digite\s+aqui\s+o\s+n[úu]mero\s+da\s+nota\s+fiscal|n[úu]mero\s+da\s+nota\s+fiscal|nota\s+fiscal)/i,
  /cro\s*\/?\s*uf/i,
  /cpf\s*(?:\/|\s)\s*cnpj/i,
  /c[óo]digo\s+do\s+cliente/i,
];

export function isOutlookFormsDocument(text: string): boolean {
  if (!text) return false;
  let matches = 0;
  for (const rx of OUTLOOK_FORMS_ANCHORS) {
    if (rx.test(text)) {
      matches++;
    }
  }
  return matches >= 3;
}

interface AnchorRule {
  key: string;
  pattern: RegExp;
  label: string;
  category?: 'FISCAL' | 'CLIENTE' | 'CONTATO' | 'SENSITIVE' | 'CLINICO' | 'OUTROS';
  isSensitive?: boolean;
}

const FORM_ANCHOR_RULES: AnchorRule[] = [
  { key: 'customerName', pattern: /^nome\s+do\s+profissional/i, label: 'Nome do Profissional' },
  { key: 'croUf', pattern: /^cro\s*\/?\s*uf/i, label: 'CRO/UF', category: 'SENSITIVE', isSensitive: true },
  { key: 'cpfCnpj', pattern: /^cpf\s*(?:\/|\s)\s*cnpj/i, label: 'CPF / CNPJ', category: 'SENSITIVE', isSensitive: true },
  { key: 'customerCode', pattern: /^c[óo]digo\s+do\s+cliente/i, label: 'Código do cliente', category: 'CLIENTE' },
  { key: 'phone', pattern: /^telefone/i, label: 'Telefone', category: 'CONTATO', isSensitive: true },
  { key: 'email', pattern: /^e-?mail/i, label: 'E-mail', category: 'CONTATO', isSensitive: true },
  { key: 'address', pattern: /^endere[çc]o/i, label: 'Endereço', category: 'SENSITIVE', isSensitive: true },
  { key: 'productCode', pattern: /^c[óo]digo\s+do\s+produto/i, label: 'Código do produto' },
  { key: 'productDescription', pattern: /^descri[çc][ãa]o\s+do\s+produto/i, label: 'Descrição do produto' },
  { key: 'batchNumber', pattern: /^(?:n[úu]mero\s+do\s+lote|n[úu]m\.?\s*do\s*lote|lote\s*[:\?]?$)/i, label: 'Número do lote' },
  { key: 'quantity', pattern: /^(?:quantidade|qtd)\b/i, label: 'Quantidade' },
  { key: 'occurrenceDescription', pattern: /^descri[çc][ãa]o\s+da\s+ocorr[êe]ncia/i, label: 'Descrição da ocorrência' },
  { key: 'occurrenceReason', pattern: /^qual\s+foi\s+o\s+ocorrido\??/i, label: 'Qual foi o ocorrido?', category: 'OUTROS' },
  {
    key: 'invoiceNumber',
    pattern: /^(?:digite\s+aqui\s+o\s+n[úu]mero\s+da\s+nota\s+fiscal|n[úu]mero\s+da\s+nota\s+fiscal|nota\s+fiscal\s*[:\?]?$)/i,
    label: 'Número da nota fiscal',
    category: 'FISCAL',
  },
  { key: 'clinicalPhotos', pattern: /^fa[çc]a\s+aqui\s+o\s+envio/i, label: 'Arquivos ou evidências', category: 'CLINICO' },
  { key: 'torqueWrenchUsed', pattern: /^foi\s+utilizado\s+torqu[íi]metro/i, label: 'Foi utilizado torquímetro?', category: 'CLINICO' },
  { key: 'prosthesisType', pattern: /^\*?qual\s+o\s+tipo\s+de\s+pr[óo]tese/i, label: 'Tipo de prótese', category: 'CLINICO' },
  { key: 'fixationType', pattern: /^qual\s+o\s+tipo\s+de\s+fixa[çc][ãa]o/i, label: 'Tipo de fixação', category: 'CLINICO' },
  { key: 'prosthesisMaterial', pattern: /^qual\s+o\s+material\s+utilizado/i, label: 'Material da prótese', category: 'CLINICO' },
  { key: 'installationDate', pattern: /^quando\s+foi\s+instalado\s+o\s+componente/i, label: 'Data de instalação do componente', category: 'CLINICO' },
  { key: 'provInstallationDate', pattern: /^data\s+da\s+instala[çc][ãa]o\s+da\s+pr[óo]tese/i, label: 'Data da prótese provisória', category: 'CLINICO' },
  { key: 'controlConsultations', pattern: /^foi\s+realizado\s+consultas/i, label: 'Consultas controle periódicas', category: 'CLINICO' },
  { key: 'acquiredByWhom', pattern: /^o\s+item\s+pode\s+ter\s+sido\s+adquirido/i, label: 'Aquisição em nome de outrem', category: 'OUTROS' },
  { key: 'wantsReplacement', pattern: /^deseja\s+receber\s+a\s+reposi[çc][ãa]o/i, label: 'Deseja reposição do item?', category: 'OUTROS' },
  { key: 'additionalNotes', pattern: /^observa[çc][õo]es(?:\s+adicionais)?/i, label: 'Observações adicionais', category: 'OUTROS' },
];

function isNoiseLine(line: string): boolean {
  if (!line) return true;
  const l = line.trim();
  if (/^https?:\/\//i.test(l)) return true;
  if (/^map it$/i.test(l)) return true;
  if (/^\d{1,2}\/\d{1,2}\/\d{4},\s*\d{1,2}:\d{2}\s+(?:ABRIR|\w+)/i.test(l)) return true;
  if (/^--\s*\d+\s*of\s*\d+\s*--/i.test(l)) return true;
  if (/^Declaração de Veracidade/i.test(l)) return true;
  if (/^Declaro serem verdadeiras/i.test(l)) return true;
  if (/^devidamente esterilizados/i.test(l)) return true;
  if (/^esterilização de materiais/i.test(l)) return true;
  if (/^Consentir$/i.test(l)) return true;
  if (/^Eu concordo com a Política/i.test(l)) return true;
  return false;
}

function parseEmailHeaderDate(text: string): string {
  const match = text.match(/Data\s+(?:[A-Za-zçã]+,\s*)?(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})\s*(\d{1,2}:\d{2})?/i);
  if (match) {
    const dateStr = match[1];
    const timeStr = match[2] || '09:00';
    const parts = dateStr.split(/[\/\-\.]/);
    if (parts.length === 3) {
      let day = parseInt(parts[0], 10);
      let month = parseInt(parts[1], 10);
      let year = parseInt(parts[2], 10);
      if (year < 100) year += 2000;
      const [h, m] = timeStr.split(':').map(x => parseInt(x, 10));
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${year}-${pad(month)}-${pad(day)}T${pad(h || 9)}:${pad(m || 0)}`;
    }
  }
  return '';
}

export function parseOutlookFormsDocument(raw: RawDocumentText): InterpretedForm {
  const text = raw.text;
  const warnings = [...raw.warnings];
  const rawFields: Record<string, string> = {};

  const lines = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !isNoiseLine(l));

  const parsedSections: Record<string, { label: string; value: string; isSensitive?: boolean; category?: any }> = {};
  let currentRule: AnchorRule | null = null;
  let currentValues: string[] = [];

  for (const line of lines) {
    const matched = FORM_ANCHOR_RULES.find(r => r.pattern.test(line));
    if (matched) {
      if (currentRule) {
        parsedSections[currentRule.key] = {
          label: currentRule.label,
          value: currentValues.join(' ').trim(),
          isSensitive: currentRule.isSensitive,
          category: currentRule.category,
        };
      }
      currentRule = matched;
      currentValues = [];

      // Check if value is on the same line after a colon (e.g. "Telefone: (11) 9999-9999")
      const colonIdx = line.indexOf(':');
      if (colonIdx > -1 && colonIdx < line.length - 1) {
        const potential = line.slice(colonIdx + 1).trim();
        if (potential.length > 0 && !matched.pattern.test(potential)) {
          currentValues.push(potential);
        }
      }
    } else if (currentRule) {
      currentValues.push(line);
    }
  }

  if (currentRule) {
    parsedSections[currentRule.key] = {
      label: currentRule.label,
      value: currentValues.join(' ').trim(),
      isSensitive: currentRule.isSensitive,
      category: currentRule.category,
    };
  }

  // 1. Customer Name
  const rawCustomer = parsedSections.customerName?.value || '';
  const cleanCustomer = rawCustomer.replace(/^(?:dr|dra|sr|sra)\.?\s+/i, '').trim();
  const customerName: CandidateField = cleanCustomer
    ? {
        value: cleanCustomer,
        sourceSnippet: `Nome do Profissional: "${rawCustomer}"`,
        confidence: 'IDENTIFIED',
        confidenceLevel: 'HIGH',
        requiresReview: false,
      }
    : {
        value: '',
        confidence: 'UNIDENTIFIED',
        confidenceLevel: 'LOW',
        requiresReview: true,
        warning: 'Nome do cliente não identificado no formulário.',
      };

  // 2. Items (Product Code, Description, Batch, Quantity)
  const items: ExtractedItem[] = [];
  const productCode = parsedSections.productCode?.value || '';
  const productDescription = parsedSections.productDescription?.value || '';
  const batchNumber = parsedSections.batchNumber?.value || '';
  const rawQty = parsedSections.quantity?.value ? parseFloat(parsedSections.quantity.value.replace(',', '.')) : 1;
  const quantity = isNaN(rawQty) || rawQty <= 0 ? 1 : rawQty;

  if (productCode || productDescription) {
    items.push({
      key: 'import-item-0',
      code: productCode || 'ITEM-1',
      description: productDescription || 'Item importado do formulário',
      batch: batchNumber,
      quantity,
      note: 'Item extraído do formulário Outlook/Forms',
      confidence: 'IDENTIFIED',
      confidenceLevel: 'HIGH',
    });
  }

  // 3. Description
  const rawDesc = parsedSections.occurrenceDescription?.value || '';
  const description: CandidateField = rawDesc
    ? {
        value: rawDesc.slice(0, 5000),
        sourceSnippet: `Descrição da ocorrência: "${rawDesc.slice(0, 120)}..."`,
        confidence: 'IDENTIFIED',
        confidenceLevel: 'HIGH',
        requiresReview: false,
      }
    : {
        value: '',
        confidence: 'UNIDENTIFIED',
        confidenceLevel: 'LOW',
        requiresReview: true,
        warning: 'Descrição da ocorrência não identificada. Preencha manualmente.',
      };

  // 4. Invoice Number (Nota Fiscal) - Strictly NOT converted to order or ticket
  const rawInvoice = parsedSections.invoiceNumber?.value || '';
  const invoiceTokenMatch = rawInvoice.match(/\b(?:NF\s*[:\-]?)?\s*([0-9]{4,12}|[A-Za-z0-9\-_]{4,20})\b/i);
  const cleanInvoice = invoiceTokenMatch ? invoiceTokenMatch[0].trim() : rawInvoice.trim();
  let invoiceNumber: CandidateField | undefined;
  if (cleanInvoice) {
    invoiceNumber = {
      value: cleanInvoice,
      sourceSnippet: `Número da Nota Fiscal: "${cleanInvoice}"`,
      confidence: 'IDENTIFIED',
      confidenceLevel: 'HIGH',
      requiresReview: false,
    };
  }

  // 5. Order Number - Strictly empty because Forms does not have Order Number
  const orderNumber: CandidateField = {
    value: '',
    confidence: 'UNIDENTIFIED',
    confidenceLevel: 'LOW',
    requiresReview: true,
    warning: 'Número do pedido não informado no formulário (apenas Nota Fiscal). Preencha caso exista.',
  };

  // 6. External Ticket - Strictly empty (never extract fragments from email headers)
  const externalTicket: CandidateField = {
    value: '',
    confidence: 'UNIDENTIFIED',
    confidenceLevel: 'LOW',
    requiresReview: false,
  };

  // 7. Contact & Address
  const phone = parsedSections.phone?.value || '';
  const email = parsedSections.email?.value || '';
  let customerContact: CandidateField | undefined;
  if (phone || email) {
    const contactParts = [phone ? `Tel: ${phone}` : '', email ? `E-mail: ${email}` : ''].filter(Boolean);
    customerContact = {
      value: contactParts.join(' | '),
      sourceSnippet: contactParts.join(' | '),
      confidence: 'IDENTIFIED',
      confidenceLevel: 'HIGH',
      requiresReview: false,
    };
  }

  const rawAddress = parsedSections.address?.value || '';
  let customerAddress: CandidateField | undefined;
  if (rawAddress) {
    customerAddress = {
      value: rawAddress,
      sourceSnippet: `Endereço: "${rawAddress}"`,
      confidence: 'IDENTIFIED',
      confidenceLevel: 'HIGH',
      requiresReview: false,
    };
  }

  // 8. OpenedAt from email header
  const parsedDate = parseEmailHeaderDate(text);
  const openedAt: CandidateField = parsedDate
    ? {
        value: parsedDate,
        sourceSnippet: 'Data identificada no cabeçalho do e-mail/formulário',
        confidence: 'IDENTIFIED',
        confidenceLevel: 'HIGH',
        requiresReview: false,
      }
    : {
        value: '',
        confidence: 'UNIDENTIFIED',
        confidenceLevel: 'LOW',
        requiresReview: false,
      };

  // 9. Channel suggestion
  const channelName: CandidateField = {
    value: 'Formulário',
    sourceSnippet: 'Formulário de Reclamação / Dúvida Técnica (Outlook/Forms)',
    confidence: 'REVIEW_REQUIRED',
    confidenceLevel: 'MEDIUM',
    requiresReview: true,
    warning: 'Canal sugerido a partir do formulário. Confirme com o canal cadastrado no SAC.',
  };

  // 10. Referenced Files (e.g. IMG_2858.jpeg)
  const referencedFiles: ReferencedDocumentFile[] = [];
  const fileMentions = text.match(/\b[\w\-_\.]+\.(?:jpe?g|png|pdf|xlsx?|docx?|zip)\b/gi) || [];
  for (const fn of new Set(fileMentions)) {
    // Exclude common domain names or obvious non-files
    if (!/implacilosstem|microsoft|outlook/i.test(fn)) {
      referencedFiles.push({
        name: fn,
        note: 'Arquivo mencionado no formulário (não incorporado no PDF). Faça o upload no campo de evidências caso tenha recebido o arquivo.',
        attached: false,
      });
    }
  }

  // 11. Additional Info (all unmapped, fiscal, clinical, and sensitive fields)
  const additionalInfo: AdditionalFieldInfo[] = [];

  if (rawInvoice) {
    additionalInfo.push({ label: 'Nota Fiscal', value: rawInvoice, category: 'FISCAL' });
  }
  if (parsedSections.customerCode?.value) {
    additionalInfo.push({ label: 'Código do Cliente', value: parsedSections.customerCode.value, category: 'CLIENTE' });
  }
  if (parsedSections.croUf?.value) {
    additionalInfo.push({
      label: 'CRO/UF',
      value: parsedSections.croUf.value,
      category: 'SENSITIVE',
      note: 'Dado cadastral profissional (apenas para conferência, não persistido no chamado)',
      isSensitive: true,
    });
  }
  if (parsedSections.cpfCnpj?.value) {
    additionalInfo.push({
      label: 'CPF / CNPJ',
      value: parsedSections.cpfCnpj.value,
      category: 'SENSITIVE',
      note: 'Dado pessoal (não persistido no chamado)',
      isSensitive: true,
    });
  }
  if (rawAddress) {
    additionalInfo.push({
      label: 'Endereço',
      value: rawAddress,
      category: 'SENSITIVE',
      note: 'Endereço profissional/consultório',
      isSensitive: true,
    });
  }
  if (phone) additionalInfo.push({ label: 'Telefone', value: phone, category: 'CONTATO', isSensitive: true });
  if (email) additionalInfo.push({ label: 'E-mail', value: email, category: 'CONTATO', isSensitive: true });

  if (parsedSections.occurrenceReason?.value) {
    additionalInfo.push({
      label: 'Qual foi o ocorrido?',
      value: parsedSections.occurrenceReason.value,
      category: 'OUTROS',
    });
  }

  // Clinical fields
  const clinicalFields: Array<{ key: string; label: string }> = [
    { key: 'prosthesisType', label: 'Tipo de Prótese' },
    { key: 'fixationType', label: 'Tipo de Fixação' },
    { key: 'prosthesisMaterial', label: 'Material da Prótese' },
    { key: 'torqueWrenchUsed', label: 'Foi utilizado torquímetro?' },
    { key: 'installationDate', label: 'Data de instalação do componente' },
    { key: 'provInstallationDate', label: 'Data da prótese provisória' },
    { key: 'controlConsultations', label: 'Consultas controle periódicas' },
    { key: 'acquiredByWhom', label: 'Aquisição em nome de outrem' },
    { key: 'wantsReplacement', label: 'Deseja reposição do item?' },
  ];

  for (const cf of clinicalFields) {
    const val = parsedSections[cf.key]?.value;
    if (val) {
      additionalInfo.push({ label: cf.label, value: val, category: 'CLINICO' });
    }
  }

  // 12. Internal Note Summary
  const noteParts: string[] = [];
  if (rawInvoice) noteParts.push(`NF: ${rawInvoice}`);
  if (parsedSections.customerCode?.value) noteParts.push(`Cód. Cliente: ${parsedSections.customerCode.value}`);
  if (customerContact?.value) noteParts.push(`Contato: ${customerContact.value}`);
  if (batchNumber) noteParts.push(`Lote do item: ${batchNumber}`);
  if (parsedSections.occurrenceReason?.value) noteParts.push(`Motivo relatado: ${parsedSections.occurrenceReason.value}`);

  let internalNote: CandidateField | undefined;
  if (noteParts.length > 0) {
    internalNote = {
      value: noteParts.join(' | '),
      confidence: 'IDENTIFIED',
      confidenceLevel: 'HIGH',
      requiresReview: false,
    };
  }

  return {
    modelId: 'OUTLOOK_MS_FORMS',
    modelName: 'Formulário Outlook / Microsoft Forms',
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
    invoiceNumber,
    additionalInfo,
    referencedFiles,
    occurrenceReasonText: parsedSections.occurrenceReason?.value,
    rawFields,
    warnings,
  };
}
