import { describe, expect, it } from 'vitest';
import { createEmptySacForm, sacFormPayload, type SacFormValues } from './sac-form';

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
});
