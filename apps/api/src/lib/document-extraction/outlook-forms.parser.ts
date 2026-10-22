import { normalizeBatchNumber } from './batch-normalizer.js';
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
  // Identificação e Cadastro
  { key: 'customerName', pattern: /^nome\s+do\s+profissional/i, label: 'Nome do Profissional', category: 'CLIENTE' },
  { key: 'croUf', pattern: /^cro\s*\/?\s*uf/i, label: 'CRO/UF', category: 'SENSITIVE', isSensitive: true },
  { key: 'cpfCnpj', pattern: /^cpf\s*(?:\/|\s)\s*cnpj/i, label: 'CPF / CNPJ', category: 'SENSITIVE', isSensitive: true },
  { key: 'customerCode', pattern: /^c[óo]digo\s+do\s+cliente/i, label: 'Código do cliente', category: 'CLIENTE' },
  { key: 'phone', pattern: /^telefone/i, label: 'Telefone', category: 'CONTATO', isSensitive: true },
  { key: 'email', pattern: /^e-?mail/i, label: 'E-mail', category: 'CONTATO', isSensitive: true },
  { key: 'address', pattern: /^endere[çc]o/i, label: 'Endereço', category: 'SENSITIVE', isSensitive: true },

  // Produto e Lote
  { key: 'productCode', pattern: /^c[óo]digo\s+do\s+produto/i, label: 'Código do produto' },
  { key: 'productDescription', pattern: /^descri[çc][ãa]o\s+do\s+produto/i, label: 'Descrição do produto' },
  { key: 'batchNumber', pattern: /^(?:n[úu]mero\s+do\s+lote|n[úu]m\.?\s*do\s*lote|lote\s*[:\?]?$)/i, label: 'Número do lote' },
  { key: 'quantity', pattern: /^(?:quantidade|qtd)\b/i, label: 'Quantidade' },
  { key: 'acquiredByWhom', pattern: /^o\s+item\s+pode\s+ter\s+sido\s+adquirido/i, label: 'Aquisição em nome de outrem', category: 'CLINICO' },
  { key: 'wantsReplacement', pattern: /^\*?deseja\s+receber\s+a\s+reposi[çc][ãa]o/i, label: 'Deseja reposição do item?', category: 'CLINICO' },
  { key: 'replacementProduct', pattern: /^qual\s+o\s+produto\s+que\s+deseja\s+reposi[çc][ãa]o/i, label: 'Produto para reposição', category: 'CLINICO' },

  // Ocorrência
  { key: 'occurrenceDescription', pattern: /^descri[çc][ãa]o\s+da\s+ocorr[êe]ncia/i, label: 'Descrição da ocorrência' },
  { key: 'occurrenceReason', pattern: /^qual\s+foi\s+o\s+ocorrido\??/i, label: 'Qual foi o ocorrido?', category: 'CLINICO' },

  // Questionário Clínico / Técnico
  { key: 'installedRegion', pattern: /^qual\s+regi[ãa]o\s+o\s+produto\s+foi\s+instalado/i, label: 'Região instalada', category: 'CLINICO' },
  { key: 'installationDate', pattern: /^(?:quando\s+foi\s+instalado\s+o\s+componente|data\s+da\s+instala[çc][ãa]o)/i, label: 'Data da instalação', category: 'CLINICO' },
  { key: 'removalDate', pattern: /^data\s+da\s+remo[çc][ãa]o/i, label: 'Data da remoção', category: 'CLINICO' },
  { key: 'componentInstalled', pattern: /^componente\s*\(/i, label: 'Componente', category: 'CLINICO' },
  { key: 'primaryStabilityTorque', pattern: /^qual\s+foi\s+a\s+estabilidade\s+prim[áa]ria/i, label: 'Estabilidade primária (Torque Ncm)', category: 'CLINICO' },
  { key: 'immediateLoad', pattern: /^realizada\s+carga\s+imediata/i, label: 'Carga imediata?', category: 'CLINICO' },
  { key: 'boneType', pattern: /^osso\s+do\s+tipo/i, label: 'Tipo de osso', category: 'CLINICO' },
  { key: 'oralHygiene', pattern: /^higiene\s+oral/i, label: 'Higiene oral', category: 'CLINICO' },
  { key: 'prosthesisType', pattern: /^\*?qual\s+(?:o\s+)?tipo\s+de\s+pr[óo]tese/i, label: 'Tipo de prótese', category: 'CLINICO' },
  { key: 'fixationType', pattern: /^qual\s+o\s+tipo\s+de\s+fixa[çc][ãa]o/i, label: 'Tipo de fixação', category: 'CLINICO' },
  { key: 'prosthesisMaterial', pattern: /^qual\s+o\s+material\s+utilizado/i, label: 'Material da prótese', category: 'CLINICO' },
  { key: 'torqueWrenchUsed', pattern: /^foi\s+utilizado\s+torqu[íi]metro/i, label: 'Foi utilizado torquímetro?', category: 'CLINICO' },
  { key: 'controlConsultations', pattern: /^foi\s+realizado\s+consultas/i, label: 'Consultas controle periódicas', category: 'CLINICO' },
  { key: 'provInstallationDate', pattern: /^data\s+da\s+instala[çc][ãa]o\s+da\s+pr[óo]tese/i, label: 'Data da prótese provisória', category: 'CLINICO' },
  { key: 'patientAge', pattern: /^idade\b/i, label: 'Idade do paciente', category: 'CLINICO' },
  { key: 'patientGender', pattern: /^sexo\b/i, label: 'Sexo do paciente', category: 'CLINICO' },
  { key: 'patientClinicalData', pattern: /^dados\s+cl[íi]nicos\s+do\s+paciente/i, label: 'Dados clínicos do paciente', category: 'CLINICO' },
  { key: 'allergies', pattern: /^alergia\s*\/?\s*hipersensibilidade/i, label: 'Alergia/Hipersensibilidade', category: 'CLINICO' },
  { key: 'recentSurgery', pattern: /^alguma\s+cirurgia\s+recente/i, label: 'Cirurgia recente?', category: 'CLINICO' },
  { key: 'continuousMedication', pattern: /^faz\s+uso\s+cont[íi]nuo/i, label: 'Medicamento contínuo', category: 'CLINICO' },
  { key: 'otherDiseases', pattern: /^outras\s+doen[çc]as/i, label: 'Outras doenças', category: 'CLINICO' },
  { key: 'lossAccompaniedBy', pattern: /^a\s+perda\s+do\s+implante\s+foi\s+acompanhada/i, label: 'Acontecimentos na perda', category: 'CLINICO' },
  { key: 'surgeryComplications', pattern: /^alguma\s+intercorr[êe]ncia\s+durante\s+a\s+cirurgia/i, label: 'Intercorrência cirúrgica', category: 'CLINICO' },

  // Fiscal
  {
    key: 'invoiceNumber',
    pattern: /^(?:digite\s+aqui\s+o\s+n[úu]mero\s+da\s+nota\s+fiscal|n[úu]mero\s+da\s+nota\s+fiscal|nota\s+fiscal\s*[:\?]?$)/i,
    label: 'Número da nota fiscal',
    category: 'FISCAL',
  },
  { key: 'clinicalPhotos', pattern: /^fa[çc]a\s+aqui\s+o\s+envio/i, label: 'Arquivos ou evidências', category: 'CLINICO' },
  { key: 'additionalNotes', pattern: /^observa[çc][õo]es(?:\s+adicionais)?/i, label: 'Observações adicionais', category: 'CLINICO' },
  { key: 'veracityDeclaration', pattern: /^declara[çc][ãa]o\s+de\s+veracidade/i, label: 'Declaração de Veracidade', category: 'OUTROS' },
];

function isNoiseLine(line: string): boolean {
  if (!line) return true;
  const l = line.trim();
  if (/^https?:\/\//i.test(l)) return true;
  if (/^map\s+it$/i.test(l)) return true;
  if (/^\d{1,2}\/\d{1,2}\/\d{4},\s*\d{1,2}:\d{2}\s+/i.test(l)) return true;
  if (/^--\s*\d+\s*of\s*\d+\s*--/i.test(l)) return true;
  if (/^Declaração de Veracidade/i.test(l)) return true;
  if (/^Declaro serem verdadeiras/i.test(l)) return true;
  if (/^devidamente esterilizados/i.test(l)) return true;
  if (/^esterilização de materiais/i.test(l)) return true;
  if (/^Consentir$/i.test(l)) return true;
  if (/^Eu concordo com a Política/i.test(l)) return true;
  if (/^Outlook$/i.test(l)) return true;
  if (/^De\s+Contato\s+Implacil\s+Osstem/i.test(l)) return true;
  if (/^Para\s+Serviço\s+De\s+Atendimento\s+Ao\s+Consumidor/i.test(l)) return true;
  if (/Formulário preenchido - Reclamação/i.test(l)) return true;
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

function isValidReferenceValue(val: string): boolean {
  if (!val) return false;
  const trimmed = val.trim();
  if (['?', '-', 'n/a', 'na', 'null', 'undefined', 'desconhecido', 'sem', 'não', 'nao'].includes(trimmed.toLowerCase())) {
    return false;
  }
  if (/^[0]+$/.test(trimmed)) {
    return false;
  }
  return trimmed.length >= 2 && /[A-Za-z0-9]/.test(trimmed);
}


function extractMultiItems(
  productCode: string,
  productDescription: string,
  rawBatch: string,
  rawDesc: string,
  _totalQuantity: number
): ExtractedItem[] | null {
  const codeRegex = /(\d+)\s*(?:implantes?|componentes?|itens?|unidades?|unids?|p[çc]s?|pcs?|pecas?)?\s*([A-Za-z0-9\-_]+)/gi;
  const subItems: Array<{ qty: number; code: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = codeRegex.exec(productCode)) !== null) {
    subItems.push({
      qty: parseInt(m[1], 10),
      code: m[2].trim(),
    });
  }

  if (subItems.length < 2) {
    return null;
  }

  const descParts = productDescription.split(/\s+e\s+|\s*,\s*(?=\d+\s*(?:implantes?|itens?|componentes?))/i).map(s => s.trim());
  const descLines = rawDesc
    .split(/(?<=[\.\!\?])\s+|(?=\bFoi feita\b|\bCirurgia\b)/i)
    .map(l => l.trim())
    .filter(Boolean);

  return subItems.map((sub, idx) => {
    const itemDesc = descParts[idx] || (idx === 0 ? productDescription : `Item ${idx + 1}`);

    const matchingLine = descLines.find(l => {
      const dims = itemDesc.match(/\d+[\.,]\d+\s*[xX]\s*\d+/g) || [];
      for (const d of dims) {
        const normD = d.replace(/\s+/g, '').replace(',', '.');
        if (l.replace(/\s+/g, '').replace(',', '.').includes(normD)) return true;
      }
      return false;
    }) || descLines[idx];

    let itemBatchRaw = '';
    let batchSnippet = '';
    if (matchingLine) {
      const loteMatch = matchingLine.match(/\((?:n[úu]mero\s+do\s+)?lote\s*[:\s]?\s*([A-Za-z0-9,\.\-]+)\)/i)
        || matchingLine.match(/\blote\s*[:\s]\s*([A-Za-z0-9,\.\-]+)/i);
      if (loteMatch) {
        itemBatchRaw = loteMatch[1];
        batchSnippet = `Trecho da ocorrência: "${loteMatch[0]}"`;
      }
    }

    if (!itemBatchRaw && idx === 0) {
      itemBatchRaw = rawBatch;
    }

    const batchNorm = normalizeBatchNumber(itemBatchRaw);
    const isCodeAmbiguous = sub.code.length > 5 && !/^[0-9]{4,5}$/.test(sub.code);

    return {
      key: `import-item-${idx}`,
      code: sub.code,
      description: itemDesc,
      batch: batchNorm.status === 'VALID' ? batchNorm.batch : '',
      quantity: sub.qty,
      note: itemBatchRaw && batchNorm.status === 'VALID'
        ? 'Lote identificado na descrição da ocorrência'
        : 'Item extraído com dados misturados/ambíguos; confirmar código e lote',
      confidence: (batchNorm.requiresReview || isCodeAmbiguous) ? 'REVIEW_REQUIRED' : 'IDENTIFIED',
      confidenceLevel: (batchNorm.requiresReview || isCodeAmbiguous) ? 'MEDIUM' : 'HIGH',
      requiresReview: batchNorm.requiresReview || isCodeAmbiguous,
      sourceSnippet: batchSnippet || batchNorm.sourceSnippet || `Código no texto: "${sub.code}"`,
      warning: batchNorm.warning || (isCodeAmbiguous ? `Código "${sub.code}" com formato incomum. Não corrigido por suposição; revise com o cliente.` : undefined),
      rawBatch: itemBatchRaw || undefined,
      batchStatus: batchNorm.status,
      batchCandidates: batchNorm.candidates,
      batchNotice: batchNorm.displayNotice,
    };
  });
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
  const rawBatch = parsedSections.batchNumber?.value || '';
  const rawQty = parsedSections.quantity?.value ? parseFloat(parsedSections.quantity.value.replace(',', '.')) : 1;
  const quantity = isNaN(rawQty) || rawQty <= 0 ? 1 : rawQty;

  const rawDescForItems = parsedSections.occurrenceDescription?.value || '';
  const multiItems = extractMultiItems(productCode, productDescription, rawBatch, rawDescForItems, quantity);

  if (multiItems && multiItems.length > 0) {
    items.push(...multiItems);
  } else if (productCode || productDescription || rawBatch) {
    const batchNorm = normalizeBatchNumber(rawBatch);
    items.push({
      key: 'import-item-0',
      code: productCode || 'ITEM-1',
      description: productDescription || 'Item importado do formulário',
      batch: batchNorm.status === 'VALID' ? batchNorm.batch : '',
      quantity,
      note: 'Item extraído do formulário Outlook/Forms',
      confidence: batchNorm.requiresReview ? 'REVIEW_REQUIRED' : 'IDENTIFIED',
      confidenceLevel: batchNorm.confidenceLevel || 'HIGH',
      requiresReview: batchNorm.requiresReview,
      sourceSnippet: batchNorm.sourceSnippet,
      warning: batchNorm.warning,
      rawBatch: rawBatch || undefined,
      batchStatus: batchNorm.status,
      batchCandidates: batchNorm.candidates,
      batchNotice: batchNorm.displayNotice,
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
    if (/^[0]+$/.test(cleanInvoice)) {
      invoiceNumber = {
        value: cleanInvoice,
        sourceSnippet: `Número da Nota Fiscal: "${cleanInvoice}"`,
        confidence: 'REVIEW_REQUIRED',
        confidenceLevel: 'LOW',
        requiresReview: true,
        warning: 'Nota fiscal preenchida apenas com zeros ("' + cleanInvoice + '"). Valor não confiável, confirme a NF real.',
      };
    } else if (isValidReferenceValue(cleanInvoice)) {
      invoiceNumber = {
        value: cleanInvoice,
        sourceSnippet: `Número da Nota Fiscal: "${cleanInvoice}"`,
        confidence: 'IDENTIFIED',
        confidenceLevel: 'HIGH',
        requiresReview: false,
      };
    }
  }

  // 5. Order Number - Strictly empty because Forms does not have Order Number (references used instead)
  const orderNumber: CandidateField = {
    value: '',
    confidence: 'UNIDENTIFIED',
    confidenceLevel: 'LOW',
    requiresReview: false,
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
      sourceSnippet: 'Contato informado no formulário (protegido por política de privacidade)',
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
      sourceSnippet: 'Endereço informado no formulário (protegido por política de privacidade)',
      confidence: 'IDENTIFIED',
      confidenceLevel: 'HIGH',
      requiresReview: false,
    };
  }

  // 8. OpenedAt from email header: Ambiguous - do NOT treat email header date automatically as occurrence date
  const parsedDate = parseEmailHeaderDate(text);
  const openedAt: CandidateField = parsedDate
    ? {
        value: parsedDate,
        sourceSnippet: `Data no cabeçalho do e-mail: ${parsedDate.replace('T', ' ')}`,
        confidence: 'REVIEW_REQUIRED',
        confidenceLevel: 'MEDIUM',
        requiresReview: true,
        warning: 'Data identificada no cabeçalho do e-mail (sugestão pendente de confirmação). Confirme se a data clínica difere da data do envio.',
      }
    : {
        value: '',
        confidence: 'UNIDENTIFIED',
        confidenceLevel: 'LOW',
        requiresReview: true,
        warning: 'Data da ocorrência não identificada no formulário. Preencha manualmente.',
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

  // 11. Additional Info (strictly omit empty, duplicate, or invalid fields like "?")
  const additionalInfo: AdditionalFieldInfo[] = [];

  const rawCustomerCode = parsedSections.customerCode?.value || '';
  if (isValidReferenceValue(rawCustomerCode)) {
    additionalInfo.push({ label: 'Código do Cliente', value: rawCustomerCode, category: 'CLIENTE' });
  }

  if (parsedSections.croUf?.value && isValidReferenceValue(parsedSections.croUf.value)) {
    additionalInfo.push({
      label: 'CRO/UF',
      value: parsedSections.croUf.value,
      category: 'SENSITIVE',
      note: 'Dado cadastral profissional (apenas para conferência, não persistido no chamado)',
      isSensitive: true,
    });
  }

  if (parsedSections.cpfCnpj?.value && isValidReferenceValue(parsedSections.cpfCnpj.value)) {
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
      category: 'CLINICO',
    });
  }

  // Clinical / Technical fields (only include if non-empty and meaningful)
  const clinicalFields: Array<{ key: string; label: string }> = [
    { key: 'patientName', label: 'Nome do paciente' },
    { key: 'allergies', label: 'Alergia/Hipersensibilidade' },
    { key: 'installedRegion', label: 'Região instalada' },
    { key: 'installationDate', label: 'Data da instalação' },
    { key: 'removalDate', label: 'Data da remoção' },
    { key: 'primaryStabilityTorque', label: 'Estabilidade primária (Torque Ncm)' },
    { key: 'immediateLoad', label: 'Carga imediata?' },
    { key: 'boneType', label: 'Tipo de osso' },
    { key: 'oralHygiene', label: 'Higiene oral' },
    { key: 'prosthesisType', label: 'Tipo de Prótese' },
    { key: 'fixationType', label: 'Tipo de Fixação' },
    { key: 'prosthesisMaterial', label: 'Material da Prótese' },
    { key: 'torqueWrenchUsed', label: 'Foi utilizado torquímetro?' },
    { key: 'patientAge', label: 'Idade do paciente' },
    { key: 'patientGender', label: 'Sexo do paciente' },
    { key: 'recentSurgery', label: 'Cirurgia recente?' },
    { key: 'continuousMedication', label: 'Medicamento contínuo' },
    { key: 'otherDiseases', label: 'Outras doenças' },
    { key: 'surgeryComplications', label: 'Intercorrência cirúrgica' },
    { key: 'acquiredByWhom', label: 'Aquisição em nome de outrem' },
    { key: 'wantsReplacement', label: 'Deseja reposição do item?' },
    { key: 'replacementProduct', label: 'Produto para reposição' },
  ];

  for (const cf of clinicalFields) {
    const val = parsedSections[cf.key]?.value?.trim();
    if (val && val !== '?' && val !== '-') {
      const isPatientSensitive = /\b(paciente|idade|sexo|g[êe]nero|alergia|doen[çc]as?|medicamentos?|cirurgias?|intercorr[êe]ncias?|comorbidades?)\b/i.test(cf.label);
      additionalInfo.push({ label: cf.label, value: val, category: 'CLINICO', isSensitive: isPatientSensitive });
    }
  }

  // 12. Structured, concise Internal Note Summary
  const noteParts: string[] = [];
  if (cleanInvoice && isValidReferenceValue(cleanInvoice) && !/^[0]+$/.test(cleanInvoice)) noteParts.push(`NF: ${cleanInvoice}`);
  if (isValidReferenceValue(rawCustomerCode)) noteParts.push(`Cód. Cliente: ${rawCustomerCode}`);
  // When there are multiple items, the batch belongs exclusively to the corresponding item.
  // Only include batch in generic internalNote if there is exactly 1 item in the case.
  if (items.length === 1 && items[0]?.batch && /^[0-9]{6}$/.test(items[0].batch)) {
    noteParts.push(`Lote: ${items[0].batch}`);
  }
  if (parsedSections.occurrenceReason?.value) noteParts.push(`Motivo relatado: ${parsedSections.occurrenceReason.value}`);
  if (parsedSections.installationDate?.value) noteParts.push(`Instalação: ${parsedSections.installationDate.value}`);
  if (parsedSections.removalDate?.value) noteParts.push(`Remoção: ${parsedSections.removalDate.value}`);
  if (parsedSections.prosthesisType?.value) noteParts.push(`Prótese: ${parsedSections.prosthesisType.value}`);

  let internalNote: CandidateField | undefined;
  if (noteParts.length > 0) {
    internalNote = {
      value: noteParts.join(' | '),
      confidence: 'IDENTIFIED',
      confidenceLevel: 'HIGH',
      requiresReview: false,
    };
  }

  // 13. Candidate references: ONLY valid, unambiguous references
  const candidateReferences: Array<{
    type: 'ORDER' | 'INVOICE' | 'SERVICE_ORDER' | 'PROTOCOL' | 'ATTENDANCE' | 'CUSTOMER_CODE' | 'INTERNAL_DOC' | 'OTHER';
    value: string;
    label: string;
    confidence: 'IDENTIFIED' | 'REVIEW_REQUIRED' | 'UNIDENTIFIED';
  }> = [];

  if (cleanInvoice && isValidReferenceValue(cleanInvoice) && !/^[0]+$/.test(cleanInvoice)) {
    candidateReferences.push({
      type: 'INVOICE',
      value: cleanInvoice,
      label: 'Nota fiscal',
      confidence: 'IDENTIFIED',
    });
  } else if (cleanInvoice && /^[0]+$/.test(cleanInvoice)) {
    candidateReferences.push({
      type: 'INVOICE',
      value: cleanInvoice,
      label: 'Nota fiscal (não confiável / zerada)',
      confidence: 'REVIEW_REQUIRED',
    });
  }

  if (isValidReferenceValue(rawCustomerCode)) {
    candidateReferences.push({
      type: 'CUSTOMER_CODE',
      value: rawCustomerCode,
      label: 'Código do cliente',
      confidence: 'IDENTIFIED',
    });
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
    candidateReferences,
    additionalInfo,
    referencedFiles,
    occurrenceReasonText: parsedSections.occurrenceReason?.value,
    rawFields,
    warnings,
  };
}
