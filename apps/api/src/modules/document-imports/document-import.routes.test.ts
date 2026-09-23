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
}));

vi.mock('../auth/auth.middleware.js', () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const authHeader = req.headers.authorization;
    if (authHeader === 'Bearer user-1-token') {
      req.auth = { userId: 'user-1', role: 'ANALYST', sessionId: 'sess-1' };
      return next();
    }
    if (authHeader === 'Bearer user-2-token') {
      req.auth = { userId: 'user-2', role: 'ANALYST', sessionId: 'sess-2' };
      return next();
    }
    if (authHeader === 'Bearer admin-token') {
      req.auth = { userId: 'admin-1', role: 'ADMIN', sessionId: 'sess-admin' };
      return next();
    }
    return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sessão inválida.' } });
  },
  requirePermission: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
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
});
