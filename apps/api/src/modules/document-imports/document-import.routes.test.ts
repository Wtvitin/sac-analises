import express from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = vi.hoisted(() => ({
  documentImport: {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  customer: {
    findMany: vi.fn(),
  },
  channelCatalog: {
    findMany: vi.fn(),
  },
  sacRecord: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  adminAudit: {
    create: vi.fn(),
  },
}));

const mockStorage = vi.hoisted(() => ({
  exists: vi.fn().mockResolvedValue(true),
  remove: vi.fn().mockResolvedValue(undefined),
  openReadStream: vi.fn(),
  getBaseDirectory: vi.fn().mockReturnValue('data/uploads'),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('../../lib/storage/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/storage/index.js')>();
  return {
    ...actual,
    getStorageProvider: () => mockStorage,
  };
});

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ size: 1024 }),
}));

vi.mock('../auth/auth.middleware.js', () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer user-')) {
      const id = authHeader.replace('Bearer ', '').replace('-token', '');
      req.auth = { userId: id, role: 'ANALYST', sessionId: `sess-${id}` };
      return next();
    }
    if (authHeader === 'Bearer admin-token') {
      req.auth = { userId: 'admin-1', role: 'ADMIN', sessionId: 'sess-admin' };
      return next();
    }
    if (authHeader === 'Bearer viewer-token') {
      req.auth = { userId: 'user-viewer', role: 'VIEWER', sessionId: 'sess-viewer' };
      return next();
    }
    return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sessão inválida.' } });
  },
  requireRole: (...roles: string[]) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.auth && roles.includes(req.auth.role)) return next();
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Você não tem permissão para esta ação.' } });
  },
  requirePermission: (permission: string) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (permission === 'cases:write' && req.auth?.role === 'VIEWER') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Você não tem permissão para esta ação.' } });
    }
    return next();
  },
}));

// Mock extractDocumentData so route tests don't run heavy OCR in unit suite
vi.mock('../../lib/document-extraction/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/document-extraction/index.js')>();
  return {
    ...actual,
    extractDocumentData: vi.fn().mockResolvedValue({
      externalTicket: { value: 'AT-88899', sourceSnippet: 'Atendimento: AT-88899', confidence: 'IDENTIFIED', label: 'Atendimento' },
      customerName: { value: 'Acme Corp', sourceSnippet: 'Cliente: Acme Corp', confidence: 'IDENTIFIED', label: 'Cliente' },
      contactName: { value: 'John Doe', sourceSnippet: 'Contato: John Doe', confidence: 'IDENTIFIED', label: 'Contato' },
      orderNumber: { value: '333681', sourceSnippet: 'pedido 333681', confidence: 'IDENTIFIED', label: 'Pedido' },
      openedAt: { value: '2026-03-10T09:00:00.000Z', sourceSnippet: 'Data: 10/03/2026 09:00', confidence: 'IDENTIFIED', label: 'Data' },
      channel: { value: 'WhatsApp', sourceSnippet: 'Comunicação: WhatsApp', confidence: 'REVIEW_REQUIRED', label: 'Canal', note: 'Canal sem correspondência interna.' },
      description: { value: 'Problema na entrega.', sourceSnippet: 'Problema na entrega.', confidence: 'IDENTIFIED', label: 'Descrição' },
      items: [{ code: 'PROD-1', description: 'Item 1', quantity: 2, confidence: 'IDENTIFIED' }],
      unmatchedFields: [],
      candidateDuplicateCases: [],
      candidateCustomer: null,
      warnings: [],
    }),
  };
});

import { documentImportRouter } from './document-import.routes.js';
import { confirmDocumentImport } from './document-import.service.js';

let server: Server | undefined;

async function request(path: string, init?: RequestInit) {
  const app = express();
  app.use(express.json());
  app.use('/document-imports', documentImportRouter);
  server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server unavailable');
  return fetch(`http://127.0.0.1:${address.port}${path}`, init);
}

describe('Document Imports API Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage.exists.mockResolvedValue(true);
    mockStorage.remove.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  });

  describe('POST /document-imports', () => {
    it('requires authentication', async () => {
      const res = await request('/document-imports', {
        method: 'POST',
      });
      expect(res.status).toBe(401);
    });

    it('rejects request from VIEWER role without cases:write permission', async () => {
      const formData = new FormData();
      const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.4\n%test\n'), Buffer.alloc(100)]);
      formData.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'formulario.pdf');

      const res = await request('/document-imports', {
        method: 'POST',
        headers: { authorization: 'Bearer viewer-token' },
        body: formData,
      });
      expect(res.status).toBe(403);
      const json = await res.json() as any;
      expect(json.error.code).toBe('FORBIDDEN');
    });

    it('rejects request with no file attached', async () => {
      const formData = new FormData();
      const res = await request('/document-imports', {
        method: 'POST',
        headers: { authorization: 'Bearer user-1-token' },
        body: formData,
      });
      expect(res.status).toBe(400);
      const json = await res.json() as any;
      expect(json.error.code).toBe('FILE_EMPTY');
    });

    it('rejects disguised/invalid file with unknown magic bytes', async () => {
      const formData = new FormData();
      const fakeBlob = new Blob(['corrupted invalid file payload'], { type: 'application/pdf' });
      formData.append('file', fakeBlob, 'teste.pdf');

      const res = await request('/document-imports', {
        method: 'POST',
        headers: { authorization: 'Bearer user-1-token' },
        body: formData,
      });

      expect(res.status).toBe(400);
      const json = await res.json() as any;
      expect(json.error.message).toMatch(/não suportado/);
    });

    it('creates import session and returns extracted data for valid PDF', async () => {
      const formData = new FormData();
      // Valid PDF magic bytes: %PDF-1.4
      const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.4\n%test\n'), Buffer.alloc(100)]);
      const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });
      formData.append('file', pdfBlob, 'formulario.pdf');

      mockPrisma.documentImport.create.mockResolvedValue({
        id: 'session-uuid-1',
        userId: 'user-1',
        originalName: 'formulario.pdf',
        format: 'PDF',
        status: 'READY_FOR_REVIEW',
        storageKey: 'temp/imports/session-uuid-1.pdf',
        error: null,
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      });

      const res = await request('/document-imports', {
        method: 'POST',
        headers: { authorization: 'Bearer user-1-token' },
        body: formData,
      });

      expect(res.status).toBe(201);
      const json = await res.json() as any;
      expect(json.data.id).toBe('session-uuid-1');
      expect(json.data.status).toBe('READY_FOR_REVIEW');
      expect(json.data.extractedData.customerName.value).toBe('Acme Corp');
      expect(json.data.extractedData.orderNumber.value).toBe('333681');
    });

    it('enforces rate limiting per authenticated user without blocking distinct users on the same IP', async () => {
      // User A makes 25 requests (exhausting their quota)
      for (let i = 0; i < 25; i++) {
        const res = await request('/document-imports', {
          method: 'POST',
          headers: { authorization: 'Bearer user-quota-a-token' },
        });
        expect(res.status).toBe(400); // Fails file check, but counts against user rate limiter
      }

      // 26th request by User A: rate limited with 429
      const blockedRes = await request('/document-imports', {
        method: 'POST',
        headers: { authorization: 'Bearer user-quota-a-token' },
      });
      expect(blockedRes.status).toBe(429);
      const blockedJson = await blockedRes.json() as any;
      expect(blockedJson.error.code).toBe('TOO_MANY_REQUESTS');
      expect(blockedJson.error.message).toContain('usuário');

      // User B on the SAME IP (127.0.0.1) performs a request: allowed through!
      const userBRes = await request('/document-imports', {
        method: 'POST',
        headers: { authorization: 'Bearer user-quota-b-token' },
      });
      expect(userBRes.status).toBe(400); // NOT 429
      const userBJson = await userBRes.json() as any;
      expect(userBJson.error.code).toBe('FILE_EMPTY');
    });

    it('creates import session and returns extracted data for valid PDF via /document-imports/upload alias', async () => {
      const formData = new FormData();
      const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.4\n%test\n'), Buffer.alloc(100)]);
      const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });
      formData.append('file', pdfBlob, 'formulario-alias.pdf');

      mockPrisma.documentImport.create.mockResolvedValue({
        id: 'session-uuid-alias',
        userId: 'user-1',
        originalName: 'formulario-alias.pdf',
        format: 'PDF',
        status: 'READY_FOR_REVIEW',
        storageKey: 'temp/imports/session-uuid-alias.pdf',
        error: null,
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      });

      const res = await request('/document-imports/upload', {
        method: 'POST',
        headers: { authorization: 'Bearer user-1-token' },
        body: formData,
      });

      expect(res.status).toBe(201);
      const json = await res.json() as any;
      expect(json.data.id).toBe('session-uuid-alias');
      expect(json.data.status).toBe('READY_FOR_REVIEW');
    });

    it('rejects file exceeding 10 MB with HTTP 422, LIMIT_FILE_SIZE code and clear message (not HTTP 500)', async () => {
      const formData = new FormData();
      // 11 MB payload
      const largeBytes = Buffer.alloc(11 * 1024 * 1024, 0x41);
      const largeBlob = new Blob([largeBytes], { type: 'application/pdf' });
      formData.append('file', largeBlob, 'arquivo-gigante.pdf');

      const res = await request('/document-imports', {
        method: 'POST',
        headers: { authorization: 'Bearer user-1-token' },
        body: formData,
      });

      expect(res.status).toBe(422);
      expect(res.status).not.toBe(500);
      const json = await res.json() as any;
      expect(json).toHaveProperty('error');
      expect(json.error.code).toBe('LIMIT_FILE_SIZE');
      expect(json.error.message).toContain('10 MB');
    });

    it('rejects file exceeding 10 MB also via /document-imports/upload alias preserving JSON structure', async () => {
      const formData = new FormData();
      const largeBytes = Buffer.alloc(11 * 1024 * 1024, 0x41);
      const largeBlob = new Blob([largeBytes], { type: 'application/pdf' });
      formData.append('file', largeBlob, 'arquivo-gigante-alias.pdf');

      const res = await request('/document-imports/upload', {
        method: 'POST',
        headers: { authorization: 'Bearer user-1-token' },
        body: formData,
      });

      expect(res.status).toBe(422);
      expect(res.status).not.toBe(500);
      const json = await res.json() as any;
      expect(json).toEqual({
        error: {
          code: 'LIMIT_FILE_SIZE',
          message: 'O arquivo deve possuir até 10 MB.',
        },
      });
    });

    it('rejects unexpected upload field name with HTTP 422, LIMIT_UNEXPECTED_FILE and clear message', async () => {
      const formData = new FormData();
      const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.4\n%test\n'), Buffer.alloc(100)]);
      formData.append('documento_invalido', new Blob([pdfBytes], { type: 'application/pdf' }), 'formulario.pdf');

      const res = await request('/document-imports', {
        method: 'POST',
        headers: { authorization: 'Bearer user-1-token' },
        body: formData,
      });

      expect(res.status).toBe(422);
      expect(res.status).not.toBe(500);
      const json = await res.json() as any;
      expect(json.error.code).toBe('LIMIT_UNEXPECTED_FILE');
      expect(json.error.message).toBe('Envie apenas um arquivo de formulário.');
    });
  });


  describe('GET /document-imports/:id', () => {
    it('requires authentication', async () => {
      const res = await request('/document-imports/session-1');
      expect(res.status).toBe(401);
    });

    it('returns 404 if session not found', async () => {
      mockPrisma.documentImport.findUnique.mockResolvedValue(null);
      const res = await request('/document-imports/session-999', {
        headers: { authorization: 'Bearer user-1-token' },
      });
      expect(res.status).toBe(404);
    });

    it('enforces user isolation (User B cannot access User A session)', async () => {
      mockPrisma.documentImport.findUnique.mockResolvedValue({
        id: 'session-user-1',
        userId: 'user-1',
        originalName: 'form.pdf',
        format: 'PDF',
        status: 'READY_FOR_REVIEW',
        extractedData: null,
        error: null,
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      });

      const res = await request('/document-imports/session-user-1', {
        headers: { authorization: 'Bearer user-2-token' },
      });

      expect(res.status).toBe(403);
      const json = await res.json() as any;
      expect(json.error.code).toBe('FORBIDDEN');
    });

    it('allows owner to access their own import session', async () => {
      mockPrisma.documentImport.findUnique.mockResolvedValue({
        id: 'session-user-1',
        userId: 'user-1',
        originalName: 'form.pdf',
        format: 'PDF',
        status: 'READY_FOR_REVIEW',
        extractedData: { externalTicket: { value: 'AT-100', confidence: 'IDENTIFIED' } },
        error: null,
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      });

      const res = await request('/document-imports/session-user-1', {
        headers: { authorization: 'Bearer user-1-token' },
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.data.id).toBe('session-user-1');
      expect(json.data.extractedData.externalTicket.value).toBe('AT-100');
    });

    it('allows ADMIN to inspect any import session', async () => {
      mockPrisma.documentImport.findUnique.mockResolvedValue({
        id: 'session-user-1',
        userId: 'user-1',
        originalName: 'form.pdf',
        format: 'PDF',
        status: 'READY_FOR_REVIEW',
        extractedData: null,
        error: null,
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      });

      const res = await request('/document-imports/session-user-1', {
        headers: { authorization: 'Bearer admin-token' },
      });

      expect(res.status).toBe(200);
    });
  });

  describe('DELETE /document-imports/:id', () => {
    it('cancels session and removes temporary storage file', async () => {
      mockPrisma.documentImport.findUnique.mockResolvedValue({
        id: 'session-user-1',
        userId: 'user-1',
        storageKey: 'temp/imports/session-user-1.pdf',
        status: 'READY_FOR_REVIEW',
      });
      mockPrisma.documentImport.update.mockResolvedValue({});

      const res = await request('/document-imports/session-user-1', {
        method: 'DELETE',
        headers: { authorization: 'Bearer user-1-token' },
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.data.success).toBe(true);
      expect(mockPrisma.documentImport.update).toHaveBeenCalledWith({
        where: { id: 'session-user-1' },
        data: { status: 'CANCELLED' },
      });
      expect(mockStorage.remove).toHaveBeenCalledWith('temp/imports/session-user-1.pdf');
    });

    it('prevents unauthorized cancellation from another user', async () => {
      mockPrisma.documentImport.findUnique.mockResolvedValue({
        id: 'session-user-1',
        userId: 'user-1',
        storageKey: 'temp/imports/session-user-1.pdf',
        status: 'READY_FOR_REVIEW',
      });

      const res = await request('/document-imports/session-user-1', {
        method: 'DELETE',
        headers: { authorization: 'Bearer user-2-token' },
      });

      expect(res.status).toBe(403);
      expect(mockPrisma.documentImport.update).not.toHaveBeenCalled();
      expect(mockStorage.remove).not.toHaveBeenCalled();
    });
  });

  describe('POST /document-imports/:id/reveal', () => {
    it('blocks non-admin users with 403 Forbidden', async () => {
      const res = await request('/document-imports/session-user-1/reveal', {
        method: 'POST',
        headers: {
          authorization: 'Bearer user-1-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ fieldPath: 'additionalInfo.0' }),
      });

      expect(res.status).toBe(403);
    });

    it('allows ADMIN to reveal sensitive field and logs audit without storing value', async () => {
      mockPrisma.documentImport.findUnique.mockResolvedValue({
        id: 'session-user-1',
        userId: 'user-1',
        originalName: 'form.pdf',
        format: 'PDF',
        status: 'READY_FOR_REVIEW',
        extractedData: {
          additionalInfo: [
            { label: 'CPF', value: '123.456.789-00', category: 'SENSITIVE', confidence: 'IDENTIFIED' },
          ],
        },
        error: null,
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      });
      mockPrisma.adminAudit.create.mockResolvedValue({});

      const res = await request('/document-imports/session-user-1/reveal', {
        method: 'POST',
        headers: {
          authorization: 'Bearer admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ fieldPath: 'additionalInfo.0' }),
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.data.fieldPath).toBe('additionalInfo.0');
      expect(json.data.revealedValue).toBe('123.456.789-00');
      expect(json.data.category).toBe('CPF_CNPJ');

      // Verify audit was created and DOES NOT contain the sensitive value
      expect(mockPrisma.adminAudit.create).toHaveBeenCalledTimes(1);
      const auditCall = mockPrisma.adminAudit.create.mock.calls[0][0];
      expect(auditCall.data.type).toBe('SENSITIVE_DATA_REVEALED');
      expect(auditCall.data.actorId).toBe('admin-1');
      expect(auditCall.data.metadata.category).toBe('CPF_CNPJ');
      expect(auditCall.data.metadata.fieldPath).toBe('additionalInfo.0');
      // Assert sensitive value is NEVER stored in audit
      expect(JSON.stringify(auditCall.data)).not.toContain('123.456.789-00');
    });

    it('allows ADMIN to reveal protected referenced file name with CLINICAL category and audit log', async () => {
      mockPrisma.documentImport.findUnique.mockResolvedValue({
        id: 'session-user-1',
        userId: 'user-1',
        originalName: 'form.pdf',
        format: 'PDF',
        status: 'READY_FOR_REVIEW',
        extractedData: {
          referencedFiles: [
            { name: '16-05-2025-Paciente-Teste-Ficticio-16-12-19621.jpeg', attached: false },
          ],
        },
        error: null,
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      });
      mockPrisma.adminAudit.create.mockResolvedValue({});

      const res = await request('/document-imports/session-user-1/reveal', {
        method: 'POST',
        headers: {
          authorization: 'Bearer admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ fieldPath: 'referencedFiles.0' }),
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.data.fieldPath).toBe('referencedFiles.0');
      expect(json.data.revealedValue).toBe('16-05-2025-Paciente-Teste-Ficticio-16-12-19621.jpeg');
      expect(json.data.category).toBe('CLINICAL');

      // Verify audit event
      const auditCalls = mockPrisma.adminAudit.create.mock.calls;
      const lastAudit = auditCalls[auditCalls.length - 1][0];
      expect(lastAudit.data.type).toBe('SENSITIVE_DATA_REVEALED');
      expect(lastAudit.data.metadata.category).toBe('CLINICAL');
      expect(lastAudit.data.metadata.fieldPath).toBe('referencedFiles.0');
      expect(JSON.stringify(lastAudit.data)).not.toContain('Paciente-Teste-Ficticio');
    });
  });

  describe('confirmDocumentImport - cross-identity isolation', () => {
    it('prevents user B from confirming an import session belonging to user A', async () => {
      mockPrisma.documentImport.findUnique.mockResolvedValue({
        id: 'session-user-1',
        userId: 'user-1',
        status: 'READY_FOR_REVIEW',
        storageKey: 'temp/imports/session-user-1.pdf',
        originalName: 'form.pdf',
        format: 'PDF',
      });

      // User 2 attempts to confirm user 1's session
      await confirmDocumentImport('session-user-1', 'rec-hijacked', false, 'user-2');

      // Must NOT update the session
      expect(mockPrisma.documentImport.update).not.toHaveBeenCalled();
    });

    it('allows owner (user A) to confirm their own import session', async () => {
      mockPrisma.documentImport.findUnique.mockResolvedValue({
        id: 'session-user-1',
        userId: 'user-1',
        status: 'READY_FOR_REVIEW',
        storageKey: 'temp/imports/session-user-1.pdf',
        originalName: 'form.pdf',
        format: 'PDF',
      });
      mockPrisma.documentImport.update.mockResolvedValue({});

      await confirmDocumentImport('session-user-1', 'rec-legit', false, 'user-1');

      expect(mockPrisma.documentImport.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'session-user-1' },
          data: expect.objectContaining({
            status: 'CONFIRMED',
            recordId: 'rec-legit',
          }),
        })
      );
    });
  });
});


