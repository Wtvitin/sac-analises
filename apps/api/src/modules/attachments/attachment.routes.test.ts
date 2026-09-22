import express from 'express';
import type { Server } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = vi.hoisted(() => ({
  attachment: {
    findUnique: vi.fn(),
  },
}));

const mockStorage = vi.hoisted(() => ({
  exists: vi.fn(),
  openReadStream: vi.fn(),
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

vi.mock('../auth/auth.middleware.js', () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const authHeader = req.headers.authorization;
    if (authHeader === 'Bearer valid-token') {
      req.auth = { userId: 'user-1', role: 'ANALYST', sessionId: 'sess-1' };
      return next();
    }
    if (authHeader === 'Bearer no-permission') {
      req.auth = { userId: 'user-2', role: 'VIEWER', sessionId: 'sess-2' };
      return next();
    }
    return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sessão inválida.' } });
  },
  requirePermission: (perm: string) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.headers.authorization === 'Bearer no-permission') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Sem permissão.' } });
    }
    return next();
  },
}));

import { attachmentRouter } from './attachment.routes.js';

let server: Server | undefined;

async function request(path: string, init?: RequestInit) {
  const app = express();
  app.use(express.json());
  app.use('/attachments', attachmentRouter);
  server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server unavailable');
  return fetch(`http://127.0.0.1:${address.port}${path}`, init);
}

describe('attachment download HTTP routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await request('/attachments/att-1/download');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects users without cases:read permission with 403', async () => {
    const res = await request('/attachments/att-1/download', {
      headers: { Authorization: 'Bearer no-permission' },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('returns 404 for non-existent attachment or archived case', async () => {
    mockPrisma.attachment.findUnique.mockResolvedValueOnce(null);

    const res = await request('/attachments/att-missing/download', {
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('ATTACHMENT_NOT_FOUND');

    // Case is archived
    mockPrisma.attachment.findUnique.mockResolvedValueOnce({
      id: 'att-archived',
      storageKey: 'key.pdf',
      record: { archivedAt: new Date() },
      status: 'ACTIVE',
    });
    const resArchived = await request('/attachments/att-archived/download', {
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(resArchived.status).toBe(404);
  });

  it('returns 410 for quarantined or pending deletion attachment', async () => {
    mockPrisma.attachment.findUnique.mockResolvedValueOnce({
      id: 'att-quarantined',
      storageKey: 'key.pdf',
      status: 'QUARANTINED',
      record: { archivedAt: null },
    });

    const res = await request('/attachments/att-quarantined/download', {
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error.code).toBe('ATTACHMENT_UNAVAILABLE');
  });

  it('returns 404 if file record exists but physical file is missing from storage', async () => {
    mockPrisma.attachment.findUnique.mockResolvedValueOnce({
      id: 'att-missing-file',
      storageKey: 'key.pdf',
      status: 'ACTIVE',
      record: { archivedAt: null },
    });
    mockStorage.exists.mockResolvedValueOnce(false);

    const res = await request('/attachments/att-missing-file/download', {
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('ATTACHMENT_NOT_FOUND');
    // Ensure no internal physical path is exposed
    expect(JSON.stringify(body)).not.toContain('C:');
    expect(JSON.stringify(body)).not.toContain('/data/');
  });

  it('streams file successfully with safe headers (nosniff, disposition, cache control)', async () => {
    const fileContent = 'Simulated PDF Binary Stream';
    mockPrisma.attachment.findUnique.mockResolvedValueOnce({
      id: 'att-123',
      originalName: 'comprovante entrega.pdf',
      mimeType: 'application/pdf',
      sizeBytes: fileContent.length,
      storageKey: 'attachments/2026/09/uuid.pdf',
      status: 'ACTIVE',
      record: { archivedAt: null },
    });
    mockStorage.exists.mockResolvedValueOnce(true);
    mockStorage.openReadStream.mockReturnValueOnce(Readable.from([Buffer.from(fileContent)]));

    const res = await request('/attachments/att-123/download', {
      headers: { Authorization: 'Bearer valid-token' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toContain('no-store');

    // Content-Disposition with RFC 5987 UTF-8 encoding
    const disposition = res.headers.get('content-disposition');
    expect(disposition).toContain('attachment');
    expect(disposition).toContain('filename="comprovante entrega.pdf"');
    expect(disposition).toContain("filename*=UTF-8''comprovante%20entrega.pdf");

    const text = await res.text();
    expect(text).toBe(fileContent);
  });
});
