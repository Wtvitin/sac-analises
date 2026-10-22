import express from 'express';
import type { Server } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

const mockPrisma = vi.hoisted(() => {
  const table = {
    sacRecord: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      groupBy: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    activityLog: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    adminAudit: {
      create: vi.fn(),
    },
    attachment: {
      findUnique: vi.fn(),
      createMany: vi.fn(),
    },
    notification: {
      create: vi.fn(),
      createMany: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
    },
    comment: {
      create: vi.fn(),
    },
    ticketCounter: {
      upsert: vi.fn(),
    },
    customer: {
      upsert: vi.fn(),
      findMany: vi.fn(),
    },
    channel: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    reason: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    subreason: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    sacReference: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    sacItem: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    $queryRaw: vi.fn(),
  };

  return {
    ...table,
    $transaction: vi.fn(async (input: unknown) => {
      if (typeof input === 'function') {
        return (input as (tx: typeof table) => unknown)(table);
      }
      return Promise.all(input as Promise<unknown>[]);
    }),
  };
});

vi.mock('../../lib/prisma.js', () => ({
  prisma: mockPrisma,
}));

const mockStorage = vi.hoisted(() => ({
  exists: vi.fn().mockResolvedValue(true),
  openReadStream: vi.fn(() => Readable.from([Buffer.from('dados-do-anexo')])),
  persist: vi.fn().mockResolvedValue([]),
  remove: vi.fn().mockResolvedValue(undefined),
  save: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../lib/storage/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/storage/index.js')>();
  return {
    ...actual,
    getStorageProvider: () => mockStorage,
  };
});

vi.mock('../../lib/attachment-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/attachment-storage.js')>();
  return {
    ...actual,
    getAttachmentStorage: () => mockStorage,
  };
});

// Mock da autenticação por headers sintéticos
vi.mock('../auth/auth.middleware.js', () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const role = req.headers['x-test-role'] as string;
    const department = req.headers['x-test-dept'] as string | undefined;
    const userId = req.headers['x-test-user-id'] as string || 'test-user';

    if (!role) {
      return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sessão inválida.' } });
    }

    req.auth = {
      userId,
      role: role as 'ADMIN' | 'ANALYST' | 'VIEWER',
      department: department ?? null,
      sessionId: 'test-session',
    };
    return next();
  },
  requirePermission: (permission: string) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const role = req.auth?.role;
    if (permission === 'cases:write' && role === 'VIEWER') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Você não tem permissão para esta ação.' } });
    }
    return next();
  },
  requireRole: (...roles: string[]) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!roles.includes(req.auth?.role ?? '')) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Acesso restrito a administradores.' } });
    }
    return next();
  },
}));

import { requireAuth } from '../auth/auth.middleware.js';
import { sacRouter } from './sac.routes.js';
import { attachmentRouter } from '../attachments/attachment.routes.js';
import { analyticsRouter } from '../analytics/analytics.routes.js';
import { notificationRouter } from '../notifications/notification.routes.js';

describe('Segregação por Setor no SAC Análises', () => {
  let server: Server | undefined;
  let baseUrl = '';

  const updatedAt = new Date('2026-09-29T10:00:00Z');

  // Identidades sintéticas de dois setores e perfis
  const adminHeaders = { 'x-test-role': 'ADMIN', 'x-test-user-id': 'admin-1' };
  const analystAlfaHeaders = { 'x-test-role': 'ANALYST', 'x-test-user-id': 'analyst-alfa', 'x-test-dept': 'Setor Alfa' };
  const analystBetaHeaders = { 'x-test-role': 'ANALYST', 'x-test-user-id': 'analyst-beta', 'x-test-dept': 'Setor Beta' };
  const viewerAlfaHeaders = { 'x-test-role': 'VIEWER', 'x-test-user-id': 'viewer-alfa', 'x-test-dept': 'Setor Alfa' };
  const viewerBetaHeaders = { 'x-test-role': 'VIEWER', 'x-test-user-id': 'viewer-beta', 'x-test-dept': 'Setor Beta' };

  // Casos sintéticos
  const caseAlfa = {
    id: 'case-alfa',
    ticket: 'SAC-2026-0001',
    department: 'Setor Alfa',
    status: 'PENDING' as const,
    priority: 'HIGH' as const,
    assigneeId: 'analyst-alfa',
    updatedAt,
    openedAt: new Date('2026-09-20T10:00:00Z'),
    dueAt: new Date('2026-09-30T10:00:00Z'),
    lastOperationalActivityAt: updatedAt,
    archivedAt: null,
    customer: { id: 'cust-1', name: 'Cliente Alfa', document: '111.222.333-44' },
    channel: { id: 'chan-1', name: 'E-mail' },
    reason: { id: 'reas-1', name: 'Atraso' },
    assignee: { id: 'analyst-alfa', name: 'Analista Alfa', role: 'ANALYST', department: 'Setor Alfa' },
    items: [],
    references: [],
    attachments: [],
    _count: { attachments: 0 },
  };

  const caseBeta = {
    id: 'case-beta',
    ticket: 'SAC-2026-0002',
    department: 'Setor Beta',
    status: 'IN_PROGRESS' as const,
    priority: 'MEDIUM' as const,
    assigneeId: 'analyst-beta',
    updatedAt,
    openedAt: new Date('2026-09-21T10:00:00Z'),
    dueAt: new Date('2026-10-01T10:00:00Z'),
    lastOperationalActivityAt: updatedAt,
    archivedAt: null,
    customer: { id: 'cust-2', name: 'Cliente Beta', document: '555.666.777-88' },
    channel: { id: 'chan-1', name: 'E-mail' },
    reason: { id: 'reas-2', name: 'Defeito' },
    assignee: { id: 'analyst-beta', name: 'Analista Beta', role: 'ANALYST', department: 'Setor Beta' },
    items: [],
    references: [],
    attachments: [],
    _count: { attachments: 0 },
  };

  const caseUnclassified = {
    id: 'case-unclass',
    ticket: 'SAC-HIST-0001',
    department: null,
    status: 'PENDING' as const,
    priority: 'LOW' as const,
    assigneeId: null,
    updatedAt,
    openedAt: new Date('2025-01-10T10:00:00Z'),
    dueAt: new Date('2025-01-20T10:00:00Z'),
    lastOperationalActivityAt: updatedAt,
    archivedAt: null,
    customer: { id: 'cust-3', name: 'Cliente Antigo', document: '999.888.777-66' },
    channel: { id: 'chan-1', name: 'E-mail' },
    reason: { id: 'reas-1', name: 'Atraso' },
    assignee: null,
    items: [],
    references: [],
    attachments: [],
    _count: { attachments: 0 },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const app = express();
    app.use(express.json());
    // Registra middleware requireAuth da mesma forma que em app.ts
    app.use('/sac-records', requireAuth, sacRouter);
    app.use('/attachments', attachmentRouter);
    app.use('/analytics', analyticsRouter);
    app.use('/notifications', notificationRouter);

    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (error instanceof ZodError) return res.status(422).json({ error: { code: 'VALIDATION_ERROR', details: error.issues } });
      const status = typeof error === 'object' && error && 'status' in error ? Number(error.status) : 500;
      const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : 'INTERNAL_ERROR';
      const message = error instanceof Error ? error.message : 'Erro interno';
      if (status === 500) console.error('TEST APP 500 ERROR:', error);
      return res.status(status).json({ error: { code, message } });
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server!.address();
        if (address && typeof address !== 'string') {
          baseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server) server.close(() => resolve());
      else resolve();
    });
  });

  async function api(path: string, options: RequestInit = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(options.headers || {}),
      },
    });
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body, headers: res.headers };
  }

  describe('1. Consulta Direta por ID (GET /sac-records/:id)', () => {
    it('permite que ANALYST e VIEWER visualizem casos do próprio setor', async () => {
      mockPrisma.sacRecord.findFirst.mockResolvedValue(caseAlfa);

      const resAnalyst = await api('/sac-records/case-alfa', { headers: analystAlfaHeaders });
      expect(resAnalyst.status).toBe(200);
      expect(resAnalyst.body.data.ticket).toBe('SAC-2026-0001');

      const resViewer = await api('/sac-records/case-alfa', { headers: viewerAlfaHeaders });
      expect(resViewer.status).toBe(200);
      expect(resViewer.body.data.ticket).toBe('SAC-2026-0001');
    });

    it('rejeita com 404 quando ANALYST ou VIEWER acessam caso de outro setor (sem vazar dados)', async () => {
      mockPrisma.sacRecord.findFirst.mockResolvedValue(caseBeta);

      const resAnalyst = await api('/sac-records/case-beta', { headers: analystAlfaHeaders });
      expect(resAnalyst.status).toBe(404);
      expect(resAnalyst.body.error.code).toBe('SAC_RECORD_NOT_FOUND');
      expect(resAnalyst.body.data).toBeUndefined();

      const resViewer = await api('/sac-records/case-beta', { headers: viewerAlfaHeaders });
      expect(resViewer.status).toBe(404);
      expect(resViewer.body.error.code).toBe('SAC_RECORD_NOT_FOUND');
    });

    it('casos históricos sem setor (department IS NULL) retornam 404 para ANALYST/VIEWER', async () => {
      mockPrisma.sacRecord.findFirst.mockResolvedValue(caseUnclassified);

      const resAnalyst = await api('/sac-records/case-unclass', { headers: analystAlfaHeaders });
      expect(resAnalyst.status).toBe(404);
      expect(resAnalyst.body.error.code).toBe('SAC_RECORD_NOT_FOUND');

      const resViewer = await api('/sac-records/case-unclass', { headers: viewerBetaHeaders });
      expect(resViewer.status).toBe(404);
      expect(resViewer.body.error.code).toBe('SAC_RECORD_NOT_FOUND');
    });

    it('ADMIN acessa casos de todos os setores e também casos históricos não classificados', async () => {
      mockPrisma.sacRecord.findFirst.mockResolvedValueOnce(caseAlfa);
      const resAlfa = await api('/sac-records/case-alfa', { headers: adminHeaders });
      expect(resAlfa.status).toBe(200);

      mockPrisma.sacRecord.findFirst.mockResolvedValueOnce(caseBeta);
      const resBeta = await api('/sac-records/case-beta', { headers: adminHeaders });
      expect(resBeta.status).toBe(200);

      mockPrisma.sacRecord.findFirst.mockResolvedValueOnce(caseUnclassified);
      const resUnclass = await api('/sac-records/case-unclass', { headers: adminHeaders });
      expect(resUnclass.status).toBe(200);
      expect(resUnclass.body.data.ticket).toBe('SAC-HIST-0001');
    });
  });

  describe('2. Listagem de Casos (GET /sac-records)', () => {
    it('aplica filtro estrito de setor no WHERE para ANALYST e VIEWER', async () => {
      mockPrisma.sacRecord.findMany.mockResolvedValue([caseAlfa]);
      mockPrisma.sacRecord.count.mockResolvedValue(1);
      mockPrisma.sacRecord.groupBy.mockResolvedValue([]);
      mockPrisma.user.findMany.mockResolvedValue([]);
      mockPrisma.reason.findMany.mockResolvedValue([]);

      const res = await api('/sac-records', { headers: analystAlfaHeaders });
      expect(res.status).toBe(200);

      // Confere que findMany foi chamado com department: 'Setor Alfa'
      expect(mockPrisma.sacRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            department: 'Setor Alfa',
          }),
        }),
      );
    });

    it('ADMIN pode listar casos de todos os setores e filtrar especificamente por setor ou unassigned', async () => {
      mockPrisma.sacRecord.findMany.mockResolvedValue([caseAlfa, caseBeta, caseUnclassified]);
      mockPrisma.sacRecord.count.mockResolvedValue(3);
      mockPrisma.sacRecord.groupBy.mockResolvedValue([]);
      mockPrisma.user.findMany.mockResolvedValue([]);
      mockPrisma.reason.findMany.mockResolvedValue([]);

      const resAll = await api('/sac-records', { headers: adminHeaders });
      expect(resAll.status).toBe(200);
      expect(mockPrisma.sacRecord.findMany.mock.calls[0][0].where.department).toBeUndefined();

      // Filtro de setor por ADMIN
      await api('/sac-records?department=Setor%20Beta', { headers: adminHeaders });
      expect(mockPrisma.sacRecord.findMany.mock.calls[1][0].where.department).toBe('Setor Beta');

      // Filtro de casos não classificados por ADMIN
      await api('/sac-records?department=unassigned', { headers: adminHeaders });
      expect(mockPrisma.sacRecord.findMany.mock.calls[2][0].where.department).toBeNull();
    });
  });

  describe('3. Criação de Casos (POST /sac-records)', () => {
    const validCreatePayload = {
      openedAt: '2026-09-29T10:00:00Z',
      dueAt: '2026-10-05T18:00:00Z',
      customerName: 'Cliente Novo',
      channelId: 'chan-1',
      reasonId: 'reas-1',
      priority: 'MEDIUM',
      description: 'Descrição do caso novo com detalhes suficientes.',
      items: [{ code: 'SKU-1', description: 'Item teste', quantity: 1 }],
    };

    it('atribui automaticamente o setor do ANALYST autenticado, ignorando department enviado', async () => {
      mockPrisma.sacRecord.findUnique.mockResolvedValue(null);
      mockPrisma.channel.findUnique.mockResolvedValue({ id: 'chan-1', active: true });
      mockPrisma.reason.findUnique.mockResolvedValue({ id: 'reas-1', active: true });
      mockPrisma.ticketCounter.upsert.mockResolvedValue({ year: 2026, value: 5 });
      mockPrisma.customer.upsert.mockResolvedValue({ id: 'cust-new', name: 'Cliente Novo' });
      mockPrisma.sacRecord.create.mockResolvedValue({ id: 'sac-new', ticket: 'SAC-2026-0005', department: 'Setor Alfa' });
      mockPrisma.sacRecord.findUniqueOrThrow.mockResolvedValue({
        id: 'sac-new',
        ticket: 'SAC-2026-0005',
        department: 'Setor Alfa',
        openedAt: new Date(),
        dueAt: new Date(),
        customer: { name: 'Cliente Novo' },
        channel: { name: 'E-mail' },
        reason: { name: 'Atraso' },
        items: [],
        references: [],
        attachments: [],
        _count: { attachments: 0 },
      });

      // ANALYST do Setor Alfa envia payload com tentativa de forçar "Setor Beta"
      const res = await api('/sac-records', {
        method: 'POST',
        headers: {
          ...analystAlfaHeaders,
          'Idempotency-Key': 'a1111111-2222-4333-8444-555555555555',
        },
        body: JSON.stringify({ ...validCreatePayload, department: 'Setor Beta' }),
      });

      expect(res.status).toBe(201);
      // Confere que no banco foi criado com 'Setor Alfa' (o setor da identidade autenticada)
      expect(mockPrisma.sacRecord.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            department: 'Setor Alfa',
          }),
        }),
      );
    });

    it('ADMIN deve informar obrigatoriamente um setor válido na criação', async () => {
      // ADMIN tenta criar sem informar department
      const resNoDept = await api('/sac-records', {
        method: 'POST',
        headers: {
          ...adminHeaders,
          'Idempotency-Key': 'b2222222-3333-4444-8555-666666666666',
        },
        body: JSON.stringify(validCreatePayload),
      });

      expect(resNoDept.status).toBe(422);
      expect(resNoDept.body.error.code).toBe('DEPARTMENT_REQUIRED');

      // ADMIN informa department válido
      mockPrisma.sacRecord.findUnique.mockResolvedValue(null);
      mockPrisma.channel.findUnique.mockResolvedValue({ id: 'chan-1', active: true });
      mockPrisma.reason.findUnique.mockResolvedValue({ id: 'reas-1', active: true });
      mockPrisma.ticketCounter.upsert.mockResolvedValue({ year: 2026, value: 6 });
      mockPrisma.customer.upsert.mockResolvedValue({ id: 'cust-new', name: 'Cliente Novo' });
      mockPrisma.sacRecord.create.mockResolvedValue({ id: 'sac-new-2', ticket: 'SAC-2026-0006', department: 'Setor Beta' });
      mockPrisma.sacRecord.findUniqueOrThrow.mockResolvedValue({
        id: 'sac-new-2',
        ticket: 'SAC-2026-0006',
        department: 'Setor Beta',
        openedAt: new Date(),
        dueAt: new Date(),
        customer: { name: 'Cliente Novo' },
        channel: { name: 'E-mail' },
        reason: { name: 'Atraso' },
        items: [],
        references: [],
        attachments: [],
        _count: { attachments: 0 },
      });

      const resWithDept = await api('/sac-records', {
        method: 'POST',
        headers: {
          ...adminHeaders,
          'Idempotency-Key': 'c3333333-4444-4555-8666-777777777777',
        },
        body: JSON.stringify({ ...validCreatePayload, department: 'Setor Beta' }),
      });

      expect(resWithDept.status).toBe(201);
      expect(mockPrisma.sacRecord.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            department: 'Setor Beta',
          }),
        }),
      );
    });

    it('VIEWER não possui permissão de escrita para criar casos', async () => {
      const res = await api('/sac-records', {
        method: 'POST',
        headers: {
          ...viewerAlfaHeaders,
          'Idempotency-Key': 'd4444444-5555-4666-8777-888888888888',
        },
        body: JSON.stringify(validCreatePayload),
      });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('4. Alterações e Operações no Caso', () => {
    it('ANALYST do Setor Alfa não pode alterar status, prioridade ou tratativa de caso do Setor Beta', async () => {
      mockPrisma.sacRecord.findFirst.mockResolvedValue(caseBeta);

      // Tentativa de alterar status
      const resStatus = await api('/sac-records/case-beta/status', {
        method: 'POST',
        headers: analystAlfaHeaders,
        body: JSON.stringify({
          status: 'COMPLETED',
          updatedAt: updatedAt.toISOString(),
          solutionSummary: 'Solução testada.',
        }),
      });
      expect(resStatus.status).toBe(404);
      expect(resStatus.body.error.code).toBe('SAC_RECORD_NOT_FOUND');

      // Tentativa de adicionar comentário
      const resComment = await api('/sac-records/case-beta/comments', {
        method: 'POST',
        headers: analystAlfaHeaders,
        body: JSON.stringify({
          body: 'Comentário indevido.',
          updatedAt: updatedAt.toISOString(),
        }),
      });
      expect(resComment.status).toBe(404);
      expect(resComment.body.error.code).toBe('SAC_RECORD_NOT_FOUND');

      // Tentativa de alterar tratativa
      const resTreatment = await api('/sac-records/case-beta/treatment', {
        method: 'PATCH',
        headers: analystAlfaHeaders,
        body: JSON.stringify({
          updatedAt: updatedAt.toISOString(),
          solutionSummary: 'Tratativa cruzada.',
        }),
      });
      expect(resTreatment.status).toBe(404);
      expect(resTreatment.body.error.code).toBe('SAC_RECORD_NOT_FOUND');
    });

    it('ANALYST do Setor Alfa altera tratativa e comentários do caso do seu próprio setor', async () => {
      mockPrisma.sacRecord.findFirst.mockResolvedValue(caseAlfa);
      mockPrisma.sacRecord.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.sacRecord.findUniqueOrThrow.mockResolvedValue(caseAlfa);
      mockPrisma.activityLog.create.mockResolvedValue({ id: 'act-1' });

      const resTreatment = await api('/sac-records/case-alfa/treatment', {
        method: 'PATCH',
        headers: analystAlfaHeaders,
        body: JSON.stringify({
          updatedAt: updatedAt.toISOString(),
          solutionSummary: 'Tratativa válida do setor Alfa.',
        }),
      });
      expect(resTreatment.status).toBe(200);
      expect(mockPrisma.sacRecord.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            solutionSummary: 'Tratativa válida do setor Alfa.',
          }),
        }),
      );
    });
  });

  describe('5. Atribuição de Responsável e Regra de Setor', () => {
    it('rejeita atribuir um ANALYST do Setor Beta a um caso do Setor Alfa (ASSIGNEE_DEPARTMENT_MISMATCH)', async () => {
      mockPrisma.sacRecord.findFirst.mockResolvedValue(caseAlfa);
      // O usuário selecionado é um ANALYST do Setor Beta
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'analyst-beta',
        name: 'Analista Beta',
        role: 'ANALYST',
        department: 'Setor Beta',
        active: true,
        approvedAt: new Date(),
      });

      const res = await api('/sac-records/case-alfa/assignee', {
        method: 'PATCH',
        headers: adminHeaders,
        body: JSON.stringify({
          assigneeId: 'analyst-beta',
          updatedAt: updatedAt.toISOString(),
        }),
      });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('ASSIGNEE_DEPARTMENT_MISMATCH');
    });

    it('permite atribuir um ANALYST do mesmo setor ao caso', async () => {
      mockPrisma.sacRecord.findFirst.mockResolvedValue({ ...caseAlfa, assigneeId: null });
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'analyst-alfa',
        name: 'Analista Alfa',
        role: 'ANALYST',
        department: 'Setor Alfa',
        active: true,
        approvedAt: new Date(),
      });
      mockPrisma.sacRecord.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.sacRecord.findUniqueOrThrow.mockResolvedValue(caseAlfa);
      mockPrisma.activityLog.create.mockResolvedValue({ id: 'act-assign' });

      const res = await api('/sac-records/case-alfa/assignee', {
        method: 'PATCH',
        headers: analystAlfaHeaders,
        body: JSON.stringify({
          assigneeId: 'analyst-alfa',
          updatedAt: updatedAt.toISOString(),
        }),
      });

      expect(res.status).toBe(200);
      expect(mockPrisma.sacRecord.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            assigneeId: 'analyst-alfa',
          }),
        }),
      );
    });
  });

  describe('6. Transferência e Classificação de Setor (PATCH /sac-records/:id/department)', () => {
    it('impede que ANALYST ou VIEWER realizem transferência de setor', async () => {
      const resAnalyst = await api('/sac-records/case-alfa/department', {
        method: 'PATCH',
        headers: analystAlfaHeaders,
        body: JSON.stringify({ department: 'Setor Beta' }),
      });
      expect(resAnalyst.status).toBe(403);

      const resViewer = await api('/sac-records/case-alfa/department', {
        method: 'PATCH',
        headers: viewerAlfaHeaders,
        body: JSON.stringify({ department: 'Setor Beta' }),
      });
      expect(resViewer.status).toBe(403);
    });

    it('ADMIN transfere caso entre setores, audita e desatribui analista se houver divergência de setor', async () => {
      // O caso Alfa está atribuído a analyst-alfa (Setor Alfa)
      mockPrisma.sacRecord.findFirst.mockResolvedValue({
        ...caseAlfa,
        assignee: { id: 'analyst-alfa', name: 'Analista Alfa', role: 'ANALYST', department: 'Setor Alfa' },
      });
      mockPrisma.sacRecord.update.mockResolvedValue({
        ...caseAlfa,
        department: 'Setor Beta',
        assigneeId: null,
      });
      mockPrisma.sacRecord.findUniqueOrThrow.mockResolvedValue({
        ...caseAlfa,
        department: 'Setor Beta',
        assigneeId: null,
      });
      mockPrisma.activityLog.create.mockResolvedValue({ id: 'act-transfer' });
      mockPrisma.adminAudit.create.mockResolvedValue({ id: 'audit-transfer' });

      const res = await api('/sac-records/case-alfa/department', {
        method: 'PATCH',
        headers: adminHeaders,
        body: JSON.stringify({
          department: 'Setor Beta',
          justification: 'Transferência aprovada para logística.',
        }),
      });

      expect(res.status).toBe(200);
      // Confere que no banco o caso foi atualizado para Setor Beta e desatribuído (assigneeId: null)
      expect(mockPrisma.sacRecord.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'case-alfa' },
          data: expect.objectContaining({
            department: 'Setor Beta',
            assigneeId: null,
          }),
        }),
      );

      // Confere auditoria no ActivityLog e no AdminAudit com setor anterior e novo
      expect(mockPrisma.activityLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            eventType: 'DEPARTMENT_TRANSFERRED',
            before: expect.objectContaining({ department: 'Setor Alfa' }),
            after: expect.objectContaining({ department: 'Setor Beta' }),
          }),
        }),
      );

      expect(mockPrisma.adminAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'CASES_TRANSFERRED',
            metadata: expect.objectContaining({
              previousDepartment: 'Setor Alfa',
              newDepartment: 'Setor Beta',
              unassigned: true,
            }),
          }),
        }),
      );
    });

    it('ADMIN classifica caso histórico não classificado (department IS NULL)', async () => {
      mockPrisma.sacRecord.findFirst.mockResolvedValue(caseUnclassified);
      mockPrisma.sacRecord.update.mockResolvedValue({
        ...caseUnclassified,
        department: 'Setor Alfa',
      });
      mockPrisma.sacRecord.findUniqueOrThrow.mockResolvedValue({
        ...caseUnclassified,
        department: 'Setor Alfa',
      });
      mockPrisma.activityLog.create.mockResolvedValue({ id: 'act-classify' });
      mockPrisma.adminAudit.create.mockResolvedValue({ id: 'audit-classify' });

      const res = await api('/sac-records/case-unclass/department', {
        method: 'PATCH',
        headers: adminHeaders,
        body: JSON.stringify({
          department: 'Setor Alfa',
          justification: 'Classificação de caso histórico pelo administrador.',
        }),
      });

      expect(res.status).toBe(200);
      expect(mockPrisma.sacRecord.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'case-unclass' },
          data: expect.objectContaining({
            department: 'Setor Alfa',
          }),
        }),
      );
    });

    it('ADMIN classifica caso com status COMPLETED preservando status, solução e histórico', async () => {
      const caseCompleted = {
        ...caseAlfa,
        id: 'case-completed',
        department: null,
        status: 'COMPLETED' as const,
        solutionSummary: 'Tratativa definitiva concluída com o cliente.',
        identifiedCause: 'Falha operacional',
        responsibleArea: 'Logística',
        correctiveAction: 'Procedimento revisado',
      };
      mockPrisma.sacRecord.findFirst.mockResolvedValue(caseCompleted);
      mockPrisma.sacRecord.update.mockResolvedValue({
        ...caseCompleted,
        department: 'Qualidade',
      });
      mockPrisma.sacRecord.findUniqueOrThrow.mockResolvedValue({
        ...caseCompleted,
        department: 'Qualidade',
      });
      mockPrisma.activityLog.create.mockResolvedValue({ id: 'act-completed' });
      mockPrisma.adminAudit.create.mockResolvedValue({ id: 'audit-completed' });

      const res = await api('/sac-records/case-completed/department', {
        method: 'PATCH',
        headers: adminHeaders,
        body: JSON.stringify({
          department: 'Qualidade',
          justification: 'Classificação de caso concluído.',
        }),
      });

      expect(res.status).toBe(200);
      expect(mockPrisma.sacRecord.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'case-completed' },
          data: expect.objectContaining({
            department: 'Qualidade',
          }),
        }),
      );
      expect(mockPrisma.sacRecord.update.mock.calls.find(c => c[0].where.id === 'case-completed')![0].data.status).toBeUndefined();
    });

    it('ADMIN classifica caso com status CANCELLED preservando status e histórico', async () => {
      const caseCancelled = {
        ...caseAlfa,
        id: 'case-cancelled',
        department: null,
        status: 'CANCELLED' as const,
        cancellationReason: 'Cancelado a pedido do cliente.',
      };
      mockPrisma.sacRecord.findFirst.mockResolvedValue(caseCancelled);
      mockPrisma.sacRecord.update.mockResolvedValue({
        ...caseCancelled,
        department: 'Estoque',
      });
      mockPrisma.sacRecord.findUniqueOrThrow.mockResolvedValue({
        ...caseCancelled,
        department: 'Estoque',
      });
      mockPrisma.activityLog.create.mockResolvedValue({ id: 'act-cancelled' });
      mockPrisma.adminAudit.create.mockResolvedValue({ id: 'audit-cancelled' });

      const res = await api('/sac-records/case-cancelled/department', {
        method: 'PATCH',
        headers: adminHeaders,
        body: JSON.stringify({
          department: 'Estoque',
          justification: 'Classificação de caso cancelado.',
        }),
      });

      expect(res.status).toBe(200);
      expect(mockPrisma.sacRecord.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'case-cancelled' },
          data: expect.objectContaining({
            department: 'Estoque',
          }),
        }),
      );
      expect(mockPrisma.sacRecord.update.mock.calls.find(c => c[0].where.id === 'case-cancelled')![0].data.status).toBeUndefined();
    });

    it('o endpoint comum de edição (PATCH /sac-records/:id) não permite contornar a transferência e ignora department', async () => {
      mockPrisma.sacRecord.findFirst.mockResolvedValueOnce({
        ...caseAlfa,
        items: [],
        _count: { attachments: 0 },
      });
      mockPrisma.channel.findUnique.mockResolvedValueOnce({ id: 'chan-1', name: 'E-mail', active: true });
      mockPrisma.reason.findUnique.mockResolvedValueOnce({ id: 'reas-1', name: 'Atraso', active: true });
      mockPrisma.customer.upsert.mockResolvedValueOnce({ id: 'cust-1', name: 'Cliente Alfa' });
      mockPrisma.sacRecord.updateMany.mockResolvedValueOnce({ count: 1 });
      mockPrisma.sacItem.deleteMany.mockResolvedValueOnce({ count: 0 });
      mockPrisma.sacReference.deleteMany.mockResolvedValueOnce({ count: 0 });
      mockPrisma.sacRecord.findUniqueOrThrow.mockResolvedValueOnce({
        ...caseAlfa,
        department: 'Setor Alfa',
      });

      const payload = {
        customerName: 'Cliente Alfa Modificado',
        channelId: 'chan-1',
        reasonId: 'reas-1',
        priority: 'HIGH',
        description: 'Atualização comum das informações do caso.',
        openedAt: new Date('2026-09-14T10:00:00Z').toISOString(),
        dueAt: new Date('2026-09-16T23:59:59Z').toISOString(),
        updatedAt: updatedAt.toISOString(),
        department: 'Setor Beta',
        items: [],
        references: [],
      };

      const res = await api('/sac-records/case-alfa', {
        method: 'PATCH',
        headers: analystAlfaHeaders,
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(200);
      const updateCall = mockPrisma.sacRecord.updateMany.mock.calls[0];
      expect(updateCall[0].data.department).toBeUndefined();
    });
  });

  describe('7. Anexos e Downloads (GET /attachments/:id/download)', () => {
    const attachmentAlfa = {
      id: 'att-alfa',
      originalName: 'comprovante-alfa.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 14,
      storageKey: 'storage-alfa.pdf',
      status: 'ACTIVE',
      record: { id: 'case-alfa', department: 'Setor Alfa', archivedAt: null },
    };

    const attachmentBeta = {
      id: 'att-beta',
      originalName: 'comprovante-beta.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 14,
      storageKey: 'storage-beta.pdf',
      status: 'ACTIVE',
      record: { id: 'case-beta', department: 'Setor Beta', archivedAt: null },
    };

    it('permite download de anexo do mesmo setor para ANALYST e VIEWER', async () => {
      mockPrisma.attachment.findUnique.mockResolvedValue(attachmentAlfa);

      const resAnalyst = await api('/attachments/att-alfa/download', { headers: analystAlfaHeaders });
      expect(resAnalyst.status).toBe(200);

      const resViewer = await api('/attachments/att-alfa/download', { headers: viewerAlfaHeaders });
      expect(resViewer.status).toBe(200);
    });

    it('bloqueia com 404 download de anexo de outro setor sem vazar informações', async () => {
      mockPrisma.attachment.findUnique.mockResolvedValue(attachmentBeta);

      const res = await api('/attachments/att-beta/download', { headers: analystAlfaHeaders });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ATTACHMENT_NOT_FOUND');
    });

    it('ADMIN tem acesso global para baixar anexos de qualquer setor', async () => {
      mockPrisma.attachment.findUnique.mockResolvedValueOnce(attachmentAlfa);
      const resAlfa = await api('/attachments/att-alfa/download', { headers: adminHeaders });
      expect(resAlfa.status).toBe(200);

      mockPrisma.attachment.findUnique.mockResolvedValueOnce(attachmentBeta);
      const resBeta = await api('/attachments/att-beta/download', { headers: adminHeaders });
      expect(resBeta.status).toBe(200);
    });
  });

  describe('8. Notificações e Isolamento de Alertas', () => {
    const notifAlfa = {
      id: 'notif-1',
      recipientId: 'analyst-alfa',
      title: 'Caso atribuído',
      recordId: 'case-alfa',
      record: { id: 'case-alfa', ticket: 'SAC-2026-0001', department: 'Setor Alfa', archivedAt: null },
    };

    it('listagem de notificações aplica restrição por setor do destinatário', async () => {
      mockPrisma.notification.findMany.mockResolvedValue([notifAlfa]);
      mockPrisma.notification.count.mockResolvedValue(1);

      const res = await api('/notifications', { headers: analystAlfaHeaders });
      expect(res.status).toBe(200);
      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            recipientId: 'analyst-alfa',
            OR: [
              { recordId: null },
              { record: { department: 'Setor Alfa', archivedAt: null } },
            ],
          }),
        }),
      );
    });

    it('detalhe da notificação retorna 404 se pertencer a caso de outro setor', async () => {
      mockPrisma.notification.findFirst.mockResolvedValue(null);

      const res = await api('/notifications/notif-2', { headers: analystAlfaHeaders });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOTIFICATION_NOT_FOUND');
    });
  });

  describe('9. Métricas, Dashboards e Exportação CSV', () => {
    it('dashboards para ANALYST contam apenas casos do seu setor', async () => {
      mockPrisma.sacRecord.count.mockResolvedValue(10);
      mockPrisma.$queryRaw.mockResolvedValue([]);

      const res = await api('/analytics/dashboard?period=30d', { headers: analystAlfaHeaders });
      expect(res.status).toBe(200);

      // Verifica que sacRecord.count filtrou por department: 'Setor Alfa'
      expect(mockPrisma.sacRecord.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            department: 'Setor Alfa',
          }),
        }),
      );
    });

    it('exportação CSV inclui coluna Setor e filtra casos por setor do analista', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'case-alfa',
          ticket: 'SAC-2026-0001',
          department: 'Setor Alfa',
          status: 'PENDING',
          priority: 'HIGH',
          customer_name: 'Cliente Alfa',
          customer_document: '111.222.333-44',
          channel_name: 'E-mail',
          reason_name: 'Atraso',
          assignee_name: 'Analista Alfa',
          opened_at: new Date('2026-09-20T10:00:00Z'),
          due_at: new Date('2026-09-30T10:00:00Z'),
          completed_at: null,
          solution_summary: null,
          identified_cause: null,
          responsible_area: null,
          corrective_action: null,
          last_activity_at: new Date('2026-09-29T10:00:00Z'),
          order_number: 'PED-123',
          reopened_count: 0,
        },
      ]).mockResolvedValueOnce([]); // Fim da paginação

      const res = await api('/analytics/export?period=30d', { headers: analystAlfaHeaders });
      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('string');
      expect(res.body).toContain('Setor');
      expect(res.body).toContain('Setor Alfa');
    });
  });

  describe('10. Pesquisa de Clientes e Detecção de Duplicidade', () => {
    it('searchCustomers isola clientes com casos no setor do ANALYST', async () => {
      mockPrisma.customer.findMany.mockResolvedValue([{ id: 'cust-1', name: 'Cliente Alfa' }]);

      const res = await api('/sac-records/customer-options?query=Cliente', { headers: analystAlfaHeaders });
      expect(res.status).toBe(200);
      expect(mockPrisma.customer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            records: {
              some: {
                department: 'Setor Alfa',
                archivedAt: null,
              },
            },
          }),
        }),
      );
    });

    it('checkExternalTicket isola duplicidade por setor do ANALYST', async () => {
      mockPrisma.sacRecord.count.mockResolvedValue(0);

      const res = await api('/sac-records/external-ticket-check?value=EXT-123', { headers: analystAlfaHeaders });
      expect(res.status).toBe(200);
      expect(mockPrisma.sacRecord.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            externalTicket: { equals: 'EXT-123', mode: 'insensitive' },
            department: 'Setor Alfa',
          }),
        }),
      );
    });
  });
});
