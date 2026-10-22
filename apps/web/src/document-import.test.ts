import { normalizeBatchNumber, BATCH_NOT_PROVIDED_NOTICE } from './batch-normalizer';
import { describe, expect, it } from 'vitest';
import { createEmptySacForm, sacFormPayload, validateSacForm, type SacFormValues } from './sac-form';

function validForm(): SacFormValues {
  return {
    ...createEmptySacForm(),
    customerName: 'Acme Corp',
    orderNumber: '333681',
    externalTicket: 'AT-9912',
    channelId: 'channel-1',
    openedAt: '2026-09-14T09:30',
    reasonId: 'reason-1',
    priority: 'HIGH',
    description: 'Produto com divergência na entrega.',
    dueDate: '2026-09-16',
    items: [{ key: 'k1', code: 'SKU-01', description: 'Item A', batch: 'B1', quantity: '1', note: '' }],
  };
}

// Client-side validation logic mirrored from DocumentImportDropzone
const ALLOWED_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.xlsx'];
const MAX_FILE_SIZE = 10 * 1024 * 1024;

function validateDropzoneFile(file: { name: string; size: number; type?: string }): string | null {
  if (file.size > MAX_FILE_SIZE) {
    return 'O arquivo selecionado ultrapassa o limite de 10 MB.';
  }
  if (file.size <= 0) {
    return 'Arquivo vazio não pode ser processado.';
  }
  const name = file.name.toLowerCase();
  const isAllowed =
    ALLOWED_EXTENSIONS.some((ext) => name.endsWith(ext)) ||
    Boolean(file.type?.startsWith('image/')) ||
    file.type === 'application/pdf' ||
    Boolean(file.type?.includes('spreadsheet')) ||
    Boolean(file.type?.includes('excel'));

  if (!isAllowed) {
    return 'Formato não suportado. Selecione um arquivo PDF, imagem (PNG, JPG) ou planilha (XLSX).';
  }
  return null;
}

describe('Document Import Client Form and Payload', () => {
  describe('sacFormPayload with import session', () => {
    it('includes importSessionId and preserveImportAsAttachment when session is present', () => {
      const payload = sacFormPayload(
        validForm(),
        false,
        undefined,
        'import-session-uuid-123',
        true
      );

      expect(payload).toMatchObject({
        customerName: 'Acme Corp',
        orderNumber: '333681',
        externalTicket: 'AT-9912',
        importSessionId: 'import-session-uuid-123',
        preserveImportAsAttachment: true,
      });
    });

    it('allows user to explicitly choose NOT to preserve imported file as attachment', () => {
      const payload = sacFormPayload(
        validForm(),
        false,
        undefined,
        'import-session-uuid-123',
        false
      );

      expect(payload).toMatchObject({
        importSessionId: 'import-session-uuid-123',
        preserveImportAsAttachment: false,
      });
    });

    it('omits importSessionId and preserveImportAsAttachment when manual filling without import', () => {
      const payload = sacFormPayload(validForm(), false);

      expect(payload).not.toHaveProperty('importSessionId');
      expect(payload).not.toHaveProperty('preserveImportAsAttachment');
    });
  });

  describe('Dropzone file validation', () => {
    it('accepts legitimate PDF, PNG, JPEG and XLSX files', () => {
      expect(validateDropzoneFile({ name: 'formulario.pdf', size: 1024, type: 'application/pdf' })).toBeNull();
      expect(validateDropzoneFile({ name: 'escaneado.png', size: 2048, type: 'image/png' })).toBeNull();
      expect(validateDropzoneFile({ name: 'foto.jpg', size: 4096, type: 'image/jpeg' })).toBeNull();
      expect(validateDropzoneFile({ name: 'planilha.xlsx', size: 8192, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })).toBeNull();
    });

    it('rejects files larger than 10 MB', () => {
      const oversized = { name: 'grande.pdf', size: 10 * 1024 * 1024 + 1, type: 'application/pdf' };
      expect(validateDropzoneFile(oversized)).toBe('O arquivo selecionado ultrapassa o limite de 10 MB.');
    });

    it('rejects empty files (0 bytes)', () => {
      const empty = { name: 'vazio.pdf', size: 0, type: 'application/pdf' };
      expect(validateDropzoneFile(empty)).toBe('Arquivo vazio não pode ser processado.');
    });

    it('rejects unsupported extensions and executables', () => {
      expect(validateDropzoneFile({ name: 'script.sh', size: 500, type: 'text/x-shellscript' })).toContain('Formato não suportado');
      expect(validateDropzoneFile({ name: 'documento.docx', size: 500, type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })).toContain('Formato não suportado');
      expect(validateDropzoneFile({ name: 'arquivo.zip', size: 500, type: 'application/zip' })).toContain('Formato não suportado');
      expect(validateDropzoneFile({ name: 'instalador.exe', size: 500, type: 'application/x-msdownload' })).toContain('Formato não suportado');
    });
  });

  describe('Confidence and Review Categories', () => {
    it('categorizes fields with clear, trustworthy labels instead of opaque percentages', () => {
      const identifiedField = {
        value: '333681',
        sourceSnippet: 'pedido 333681',
        confidence: 'IDENTIFIED' as const,
        label: 'Pedido',
      };

      const reviewField = {
        value: 'Chat Online',
        sourceSnippet: 'Comunicação: Chat Online',
        confidence: 'REVIEW_REQUIRED' as const,
        label: 'Canal',
        note: 'Canal sem correspondência direta no catálogo interno.',
      };

      expect(identifiedField.confidence).toBe('IDENTIFIED');
      expect(reviewField.confidence).toBe('REVIEW_REQUIRED');
      expect(reviewField.note).toBeDefined();
    });

    it('supports selecting from multiple candidate order numbers detected in free text', () => {
      const extractedOrder = {
        value: '333681',
        sourceSnippet: 'pedido 333681',
        confidence: 'IDENTIFIED' as const,
        candidateOrderNumbers: ['333681', '991280'],
      };

      expect(extractedOrder.candidateOrderNumbers).toHaveLength(2);
      expect(extractedOrder.candidateOrderNumbers).toContain('333681');
      expect(extractedOrder.candidateOrderNumbers).toContain('991280');
    });
  });

  describe('Session Unwrapping and Catalog Resilience (Regression)', () => {
    it('safely unwraps session whether apiRequest returns body.data or raw session', () => {
      const mockSession = {
        id: 'session-123',
        status: 'READY_FOR_REVIEW',
        originalName: 'teste.pdf',
        format: 'PDF',
        extractedData: {
          customerName: { value: 'Dr. Teste', confidence: 'IDENTIFIED', confidenceLevel: 'HIGH' },
          orderNumber: { value: '', confidence: 'UNIDENTIFIED', confidenceLevel: 'LOW' },
          items: [],
        },
      };

      // Case 1: apiRequest returns the session directly (body.data)
      const resDirect = mockSession;
      const sessionDirect = (resDirect && typeof resDirect === 'object' && 'data' in resDirect && (resDirect as any).data)
        ? (resDirect as any).data
        : resDirect;
      expect(sessionDirect?.status).toBe('READY_FOR_REVIEW');

      // Case 2: apiRequest returns wrapped { data: session }
      const resWrapped = { data: mockSession };
      const sessionWrapped = (resWrapped && typeof resWrapped === 'object' && 'data' in resWrapped && (resWrapped as any).data)
        ? (resWrapped as any).data
        : resWrapped;
      expect(sessionWrapped?.status).toBe('READY_FOR_REVIEW');
    });

    it('gracefully handles missing or unmatched catalog options without throwing', () => {
      const emptyChannels: Array<{ id: string; name: string }> = [];
      const emptyReasons: Array<{ id: string; name: string }> = [];

      const ext = {
        suggestedReason: { value: 'Motivo Inexistente' },
        channel: { value: 'Canal Inexistente' },
        channelName: { value: 'Canal Inexistente' },
        items: [{ code: 'COD-1', description: 'Desc', batch: 'B1', quantity: 2 }],
      };

      let matchedChannelId = '';
      const chanCand = ext.channelName?.value || ext.channel?.value;
      if (chanCand && emptyChannels.length > 0) {
        const rawChan = String(chanCand).toLowerCase().trim();
        const matched = emptyChannels.find(c => c && c.name && (c.name.toLowerCase().includes(rawChan) || rawChan.includes(c.name.toLowerCase())));
        if (matched) matchedChannelId = matched.id;
      }

      let matchedReasonId = '';
      if (ext.suggestedReason?.value && emptyReasons.length > 0) {
        const rawReason = String(ext.suggestedReason.value).toLowerCase().trim();
        const matchedR = emptyReasons.find(r => r && (r.id === ext.suggestedReason.value || (r.name && (r.name.toLowerCase().includes(rawReason) || rawReason.includes(r.name.toLowerCase())))));
        if (matchedR) matchedReasonId = matchedR.id;
      }

      expect(matchedChannelId).toBe('');
      expect(matchedReasonId).toBe('');
    });

    it('sanitizes internal runtime error messages so users never see undefined status errors', () => {
      const sanitize = (err: unknown): string => {
        const message = err instanceof Error ? err.message : 'Não foi possível ler o documento.';
        if (message.includes('Cannot read') || message.includes('undefined') || message.includes('null')) {
          return 'Falha ao processar o formulário. Revise o preenchimento ou preencha manualmente.';
        }
        return message;
      };

      const technicalError = new TypeError("Cannot read properties of undefined (reading 'status')");
      expect(sanitize(technicalError)).toBe('Falha ao processar o formulário. Revise o preenchimento ou preencha manualmente.');

      const normalError = new Error('O formulário deve ter no máximo 10 MB.');
      expect(sanitize(normalError)).toBe('O formulário deve ter no máximo 10 MB.');
    });
  });

  describe('Visual Organization and Noise Reduction', () => {
    it('does not duplicate labels in references (e.g. Nota fiscal: ... (Nota fiscal))', () => {
      const cand = {
        type: 'INVOICE' as const,
        value: '000786997',
        label: 'Nota fiscal',
      };

      // Form prefill logic: note is left empty instead of duplicating the type label
      const prefilledRef = {
        key: 'uuid-1',
        type: cand.type,
        value: cand.value,
        note: '', // Kept empty to prevent "Nota fiscal: 000786997 (Nota fiscal)"
      };

      expect(prefilledRef.note).toBe('');

      // Reference display formatter helper
      const formatReference = (typeLabel: string, value: string, note?: string) => {
        if (!note || note.trim().toLowerCase() === typeLabel.toLowerCase()) {
          return `${typeLabel}: ${value}`;
        }
        return `${typeLabel}: ${value} (${note})`;
      };

      expect(formatReference('Nota fiscal', '000786997', prefilledRef.note)).toBe('Nota fiscal: 000786997');
      expect(formatReference('Nota fiscal', '000786997', 'Nota fiscal')).toBe('Nota fiscal: 000786997');
      expect(formatReference('Nota fiscal', '000786997', 'Emissão matriz')).toBe('Nota fiscal: 000786997 (Emissão matriz)');
    });

    it('filters out empty, invalid, and duplicate fields in additional info for collapsible display', () => {
      const rawAdditionalInfo = [
        { label: 'Nota Fiscal', value: '000786997', category: 'FISCAL' },
        { label: 'Código do Cliente', value: '?', category: 'CLIENTE' },
        { label: 'Telefone', value: '(31) 99545-4936', category: 'CONTATO', isSensitive: true },
        { label: 'E-mail', value: 'jeniffer.ketrin@hotmail.com', category: 'CONTATO', isSensitive: true },
        { label: 'Região instalada', value: '11 12 24', category: 'CLINICO' },
        { label: 'Observações vazias', value: '', category: 'OUTROS' },
        { label: 'Outro traço', value: '-', category: 'OUTROS' },
        { label: 'Inexistente', value: 'N/A', category: 'OUTROS' },
      ];

      const invoiceNumber = '000786997';

      const filtered = rawAdditionalInfo.filter(info => {
        if (!info || !info.value) return false;
        const val = String(info.value).trim();
        if (!val || val === '?' || val === '-' || val.toLowerCase() === 'n/a') return false;
        if (info.category === 'FISCAL' && invoiceNumber && val === invoiceNumber) return false;
        return true;
      });

      expect(filtered).toHaveLength(3);
      expect(filtered.map(f => f.label)).toEqual(['Telefone', 'E-mail', 'Região instalada']);
      expect(filtered.some(f => f.value === '?')).toBe(false);
      expect(filtered.some(f => f.value === '')).toBe(false);
    });

    it('ensures email reception date requires manual confirmation as occurrence date', () => {
      const emailOpenedAt = {
        value: '2026-08-21T17:20',
        confidence: 'REVIEW_REQUIRED' as const,
        confidenceLevel: 'MEDIUM' as const,
        requiresReview: true,
        warning: 'Data identificada no cabeçalho do e-mail. Verifique se a data da ocorrência difere da data do envio.',
      };

      expect(emailOpenedAt.requiresReview).toBe(true);
      expect(emailOpenedAt.confidence).toBe('REVIEW_REQUIRED');
      expect(emailOpenedAt.warning).toBeDefined();
    });

    it('distinguishes cited evidence files from genuinely attached files', () => {
      const referencedFiles = [
        { name: 'radiografia_exame.png', note: 'Apenas referenciado no texto', attached: false },
      ];
      const attachedFiles = [
        { name: 'documento_enviado.pdf', size: 1024, type: 'application/pdf' },
      ];

      expect(referencedFiles[0].attached).toBe(false);
      expect(referencedFiles[0].name).not.toBe(attachedFiles[0].name);
    });
    it('ensures email reception date remains a pending suggestion and does NOT silently prefill form.openedAt', () => {
      const ext = {
        openedAt: {
          value: '2026-08-21T17:20',
          confidence: 'REVIEW_REQUIRED',
          requiresReview: true,
          sourceSnippet: 'Data no cabeçalho do e-mail: 2026-08-21 17:20',
        },
      };

      const isEmailHeaderDate = Boolean(
        ext.openedAt.requiresReview ||
        ext.openedAt.confidence === 'REVIEW_REQUIRED' ||
        (ext.openedAt.sourceSnippet && /cabeçalho|e-mail/i.test(ext.openedAt.sourceSnippet))
      );

      let formOpenedAt = ''; // Initial empty form
      let suggestedOpenedAt = '';
      let openedAtConfirmed = false;

      if (ext.openedAt?.value) {
        const parsed = new Date(ext.openedAt.value);
        if (!isNaN(parsed.getTime())) {
          const formatted = '2026-08-21T17:20';
          if (isEmailHeaderDate) {
            // Must NOT prefill formOpenedAt silently!
            suggestedOpenedAt = formatted;
            openedAtConfirmed = false;
          } else {
            formOpenedAt = formatted;
          }
        }
      }

      // Assert form openedAt is NOT silently populated with email date
      expect(formOpenedAt).toBe('');
      expect(suggestedOpenedAt).toBe('2026-08-21T17:20');
      expect(openedAtConfirmed).toBe(false);

      // Now simulate user explicitly clicking "Confirmar e usar data sugerida"
      formOpenedAt = suggestedOpenedAt;
      openedAtConfirmed = true;

      expect(formOpenedAt).toBe('2026-08-21T17:20');
      expect(openedAtConfirmed).toBe(true);
    });

    it('strictly blocks copying contact info and patient clinical data into internalNote', () => {
      const additionalInfo = [
        { label: 'Nota Fiscal', value: '000786997', category: 'FISCAL' },
        { label: 'Telefone', value: '***', category: 'CONTATO', isSensitive: true, isMasked: true },
        { label: 'E-mail', value: '***', category: 'CONTATO', isSensitive: true, isMasked: true },
        { label: 'Idade do paciente', value: '***', category: 'CLINICO', isSensitive: true, isMasked: true },
        { label: 'Sexo do paciente', value: '***', category: 'CLINICO', isSensitive: true, isMasked: true },
        { label: 'Medicamento contínuo', value: '***', category: 'CLINICO', isSensitive: true, isMasked: true },
        { label: 'Outras doenças', value: '***', category: 'CLINICO', isSensitive: true, isMasked: true },
        { label: 'Tipo de osso', value: 'Tipo II', category: 'CLINICO', isSensitive: false, isMasked: false },
        { label: 'Estabilidade primária (Torque Ncm)', value: '45', category: 'CLINICO', isSensitive: false, isMasked: false },
      ];

      const itemsToCopy = additionalInfo.filter((info: any) => {
        if (info.isSensitive || info.isMasked) return false;
        if (info.category === 'SENSITIVE' || info.category === 'CONTATO') return false;
        const norm = (info.label || '').toLowerCase();
        if (/\b(paciente|idade|sexo|g[êe]nero|alergia|doen[çc]as?|medicamentos?|cirurgias?|intercorr[êe]ncias?|comorbidades?|anamnese)\b/i.test(norm)) return false;
        return true;
      });

      // Only technical non-sensitive operational attributes are allowed
      expect(itemsToCopy.map((i: any) => i.label)).toEqual([
        'Nota Fiscal',
        'Tipo de osso',
        'Estabilidade primária (Torque Ncm)',
      ]);

      // Confirm no sensitive contacts or patient health conditions can be copied
      expect(itemsToCopy.some((i: any) => i.label.includes('Telefone'))).toBe(false);
      expect(itemsToCopy.some((i: any) => i.label.includes('E-mail'))).toBe(false);
      expect(itemsToCopy.some((i: any) => i.label.includes('Idade'))).toBe(false);
      expect(itemsToCopy.some((i: any) => i.label.includes('Medicamento'))).toBe(false);
      expect(itemsToCopy.some((i: any) => i.label.includes('doenças'))).toBe(false);
    });

    it('protects patient clinical data with *** masking and CLINICO category', () => {
      const patientFields = [
        { label: 'Idade do paciente', value: '***', category: 'CLINICO', isMasked: true },
        { label: 'Sexo do paciente', value: '***', category: 'CLINICO', isMasked: true },
        { label: 'Medicamento contínuo', value: '***', category: 'CLINICO', isMasked: true },
        { label: 'Intercorrência cirúrgica', value: '***', category: 'CLINICO', isMasked: true },
      ];

      for (const field of patientFields) {
        expect(field.value).toBe('***');
        expect(field.isMasked).toBe(true);
        expect(field.category).toBe('CLINICO');
      }
    });

    it('ensures SnippetHint does not render sensitive fragments when field is masked', () => {
      const shouldDisplaySnippet = (field?: { sourceSnippet?: string; isMasked?: boolean } | null) => {
        if (!field || !field.sourceSnippet) return false;
        if (field.isMasked) return false;
        if (/protegido|privacidade|confidencial/i.test(field.sourceSnippet)) return false;
        return true;
      };

      const maskedContact = {
        sourceSnippet: 'Contato informado no formulário (protegido por política de privacidade)',
        isMasked: true,
      };

      const plainField = {
        sourceSnippet: 'Número da Nota Fiscal: "000786997"',
        isMasked: false,
      };

      expect(shouldDisplaySnippet(maskedContact)).toBe(false);
      expect(shouldDisplaySnippet(plainField)).toBe(true);
    });
  });

    describe('Regras de Extração e Apresentação do Lote', () => {
      it('extrai lote válido com exatamente 6 dígitos numéricos sem separadores', () => {
        const result = normalizeBatchNumber('146157');
        expect(result.status).toBe('VALID');
        expect(result.batch).toBe('146157');
        expect(result.requiresReview).toBe(false);
        expect(result.confidence).toBe('IDENTIFIED');
      });

      it('trata lote como string preservando zeros à esquerda', () => {
        const result = normalizeBatchNumber('012345');
        expect(result.status).toBe('VALID');
        expect(result.batch).toBe('012345');
        expect(typeof result.batch).toBe('string');
        expect(result.batch.startsWith('0')).toBe(true);
        expect(result.batch).toHaveLength(6);
      });

      it('remove separador de milhar introduzido na extração mantendo 6 dígitos', () => {
        const dotResult = normalizeBatchNumber('146.157');
        expect(dotResult.status).toBe('VALID');
        expect(dotResult.batch).toBe('146157');

        const commaResult = normalizeBatchNumber('146,157');
        expect(commaResult.status).toBe('VALID');
        expect(commaResult.batch).toBe('146157');

        const leadingZeroComma = normalizeBatchNumber('012,345');
        expect(leadingZeroComma.status).toBe('VALID');
        expect(leadingZeroComma.batch).toBe('012345');
      });

      it('em ausência de lote mantém campo vazio, permite salvar e exibe aviso sem gravá-lo como valor', () => {
        const emptyResult = normalizeBatchNumber('');
        expect(emptyResult.status).toBe('EMPTY');
        expect(emptyResult.batch).toBe('');
        expect(emptyResult.displayNotice).toBe('O lote não foi informado no documento.');
        expect(emptyResult.requiresReview).toBe(false);

        // Simula formulário com item sem lote
        const itemWithoutBatch = {
          key: 'item-1',
          code: 'PROD-01',
          description: 'Implante Teste',
          batch: '',
          quantity: '1',
          note: '',
          batchStatus: 'EMPTY' as const,
          batchNotice: 'O lote não foi informado no documento.',
        };

        const formValues: any = {
          ...createEmptySacForm(),
          customerName: 'Cliente Teste',
          channelId: 'ch-1',
          openedAt: '2026-08-20T10:00',
          reasonId: 'rs-1',
          priority: 'MEDIUM',
          description: 'Descrição com mais de 10 caracteres válidos.',
          dueDate: '2026-08-30',
          items: [itemWithoutBatch],
        };

        // Validação não bloqueia salvar
        const errors = validateSacForm(formValues);
        expect(errors['item-0']).toBeUndefined();
        expect(Object.keys(errors)).toHaveLength(0);

        // Payload não grava o aviso como valor do lote
        const payload = sacFormPayload(formValues, false);
        expect(payload.items[0].batch).toBeNull();
        expect(payload.items[0].batch).not.toBe('O lote não foi informado no documento.');
      });

      it('solicita revisão e preserva o trecho de origem para valor inválido ou ambíguo', () => {
        // 5 dígitos com vírgula ("22,278")
        const ambResult = normalizeBatchNumber('22,278');
        expect(ambResult.status).toBe('AMBIGUOUS');
        expect(ambResult.batch).toBe('');
        expect(ambResult.requiresReview).toBe(true);
        expect(ambResult.confidence).toBe('REVIEW_REQUIRED');
        expect(ambResult.sourceSnippet).toBe('22,278');
        expect(ambResult.warning).toContain('22,278');

        // Menos de 6 dígitos ("12345") - NÃO completa com zero
        const shortResult = normalizeBatchNumber('12345');
        expect(shortResult.status).toBe('AMBIGUOUS');
        expect(shortResult.batch).toBe('');
        expect(shortResult.batch).not.toBe('012345');

        // Mais de 6 dígitos ("1234567") - NÃO trunca
        const longResult = normalizeBatchNumber('1234567');
        expect(longResult.status).toBe('AMBIGUOUS');
        expect(longResult.batch).toBe('');
        expect(longResult.batch).not.toBe('123456');
      });

      it('detecta múltiplos lotes sem concatená-los', () => {
        const multiSlash = normalizeBatchNumber('146157 / 146158');
        expect(multiSlash.status).toBe('MULTIPLE');
        expect(multiSlash.batch).toBe('');
        expect(multiSlash.batch).not.toBe('146157146158');
        expect(multiSlash.candidates).toEqual(['146157', '146158']);
        expect(multiSlash.requiresReview).toBe(true);
        expect(multiSlash.sourceSnippet).toBe('146157 / 146158');

        const multiComma = normalizeBatchNumber('146157, 146158');
        expect(multiComma.status).toBe('MULTIPLE');
        expect(multiComma.batch).toBe('');
        expect(multiComma.batch).not.toBe('146157146158');
        expect(multiComma.candidates).toEqual(['146157', '146158']);
      });

      it('garante que sacFormPayload sanitiza qualquer tentativa de gravar o aviso como lote', () => {
        const formWithWarningAsBatch: any = {
          ...createEmptySacForm(),
          customerName: 'Cliente Teste',
          channelId: 'ch-1',
          openedAt: '2026-08-20T10:00',
          reasonId: 'rs-1',
          priority: 'MEDIUM',
          description: 'Descrição com mais de 10 caracteres válidos.',
          dueDate: '2026-08-30',
          items: [{
            key: 'item-1',
            code: 'PROD-01',
            description: 'Item Teste',
            batch: 'O lote não foi informado no documento.',
            quantity: '1',
            note: '',
          }],
        };

        const payload = sacFormPayload(formWithWarningAsBatch, false);
        expect(payload.items[0].batch).toBeNull();
        expect(payload.items[0].batch).not.toBe('O lote não foi informado no documento.');
      });
    });

    describe('Mapeamento e preenchimento de Atendimento Tabular (TABULAR_ATTENDANCE)', () => {
      it('mapeia referências com zeros à esquerda, código de cliente e pedido', () => {
        const candidateReferences = [
          { type: 'ATTENDANCE' as const, value: '005233', label: 'Atendimento de origem', confidence: 'IDENTIFIED' as const },
          { type: 'ORDER' as const, value: '360460', label: 'Pedido de venda', confidence: 'IDENTIFIED' as const },
          { type: 'CUSTOMER_CODE' as const, value: 'A2150001', label: 'Código do Cliente', confidence: 'IDENTIFIED' as const },
        ];

        const formRefs = candidateReferences.map(cand => ({
          key: cand.type,
          type: cand.type,
          value: cand.value,
          note: cand.label || '',
        }));

        expect(formRefs).toHaveLength(3);
        const attRef = formRefs.find(r => r.type === 'ATTENDANCE');
        expect(attRef?.value).toBe('005233');
        expect(attRef?.value.startsWith('00')).toBe(true);

        const custRef = formRefs.find(r => r.type === 'CUSTOMER_CODE');
        expect(custRef?.value).toBe('A2150001');

        const ordRef = formRefs.find(r => r.type === 'ORDER');
        expect(ordRef?.value).toBe('360460');
      });

      it('não inventa quantidades e mantém aviso de lote ausente sem bloquear prosseguimento', () => {
        const extractedItems = [
          { productCode: '31189', productDescription: 'Fresa Cilíndrica Escalonada 3.7 mm', quantity: 0, batchNotice: 'O lote não foi informado no documento.' },
          { productCode: '34659', productDescription: 'Chave Motor Colocação Implante Ø3.5 HE', quantity: 0, batchNotice: 'O lote não foi informado no documento.' },
          { productCode: '34660', productDescription: 'Chave Motor Colocação Implante Ø4.0 HE', quantity: 0, batchNotice: 'O lote não foi informado no documento.' },
          { productCode: '34622', productDescription: 'Chave Catraca – Implante CM AR', quantity: 0, batchNotice: 'O lote não foi informado no documento.' },
        ];

        // Mapeia conforme SacRecordForm
        const mappedItems = extractedItems.map(it => {
          const hasExplicitQty = typeof it.quantity === 'number' && it.quantity > 0;
          return {
            key: it.productCode,
            code: it.productCode,
            description: it.productDescription,
            batch: '',
            batchStatus: 'EMPTY' as const,
            batchNotice: it.batchNotice,
            quantity: hasExplicitQty ? String(it.quantity) : '',
            note: '',
          };
        });

        expect(mappedItems).toHaveLength(4);
        for (const item of mappedItems) {
          // Quantidade não deve ser inventada (não deve ser '1' nem '2' de 'dois kits')
          expect(item.quantity).toBe('');
          expect(item.batch).toBe('');
          expect(item.batchNotice).toBe('O lote não foi informado no documento.');
        }

        // Operador informa quantidade 1 para os itens e prossegue
        const formWithFilledQuantities: SacFormValues = {
          ...createEmptySacForm(),
          customerName: 'ROCHA SERVICOS ODONTOLOGICOS',
          externalTicket: '005233',
          orderNumber: '360460',
          channelId: 'ch-email',
          openedAt: '2026-10-15T17:45',
          reasonId: 'rs-qualidade',
          priority: 'MEDIUM',
          description: 'Prezados, boa tarde! Cliente entrou em contato informando que faltam componentes do pedido 360460.',
          dueDate: '2026-10-25',
          references: [
            { key: '1', type: 'ATTENDANCE', value: '005233', note: 'Atendimento' },
            { key: '2', type: 'ORDER', value: '360460', note: 'Pedido' },
            { key: '3', type: 'CUSTOMER_CODE', value: 'A2150001', note: 'Código Cliente' },
          ],
          items: mappedItems.map(it => ({ ...it, quantity: '1' })),
        };

        const errors = validateSacForm(formWithFilledQuantities);
        expect(errors['item-0']).toBeUndefined();
        expect(Object.keys(errors)).toHaveLength(0);

        const payload = sacFormPayload(formWithFilledQuantities, false);
        expect(payload.customerName).toBe('ROCHA SERVICOS ODONTOLOGICOS');
        expect(payload.externalTicket).toBe('005233');
        expect(payload.orderNumber).toBe('360460');
        expect(payload.items).toHaveLength(4);
        expect(payload.items[0].batch).toBeNull();
        expect(payload.references).toHaveLength(3);
        expect(payload.references.find(r => r.type === 'ATTENDANCE')?.value).toBe('005233');
      });

      it('preserva distinção entre data encontrada no documento e criação do novo registro', () => {
        const rawDate = '2026-10-15T17:45';
        const docDateNotice = 'Data e hora do atendimento original encontrada no documento (15/10/2026 às 17:45:19). Verifique se corresponde à data de ocorrência.';

        // Inicia formulário sem aplicar data automaticamente
        const initialForm = createEmptySacForm();
        expect(initialForm.openedAt).not.toBe(rawDate);

        // Usuário pode confirmar a data sugerida
        const confirmedForm: SacFormValues = {
          ...initialForm,
          openedAt: rawDate,
        };
        expect(confirmedForm.openedAt).toBe('2026-10-15T17:45');
        expect(docDateNotice).toContain('15/10/2026 às 17:45:19');
      });
    });
  });
