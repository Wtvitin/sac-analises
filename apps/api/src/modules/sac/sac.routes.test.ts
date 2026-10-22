import express from 'express';
import type { Server } from 'node:http';
import { ZodError } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class SacRecordError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
  }
}

const mockSacService = vi.hoisted(() => ({
  getSacRecord: vi.fn(),
  updateSacTreatment: vi.fn(),
  listSacRecords: vi.fn(),
  createSacRecord: vi.fn(),
  revealSacRecordSensitive: vi.fn(),
  changeSacStatus: vi.fn(),
  deleteSacRecord: vi.fn(),
  SacRecordError: class SacRecordError extends Error {
    constructor(public code: string, message: string, public status: number) {
      super(message);
    }
  },
}));

vi.mock('./sac.service.js', () => mockSacService);

vi.mock('../auth/auth.middleware.js', () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const roleHeader = req.headers['x-test-role'] as string;
    const deptHeader = req.headers['x-test-department'] as string | undefined;
    if (roleHeader === 'VIEWER') {
      req.auth = { userId: 'user-viewer', role: 'VIEWER', department: deptHeader ?? null, sessionId: 'sess-1' };
      return next();
    }
    if (roleHeader === 'ANALYST') {
      req.auth = { userId: 'user-analyst', role: 'ANALYST', department: deptHeader ?? 'SAC', sessionId: 'sess-2' };
      return next();
    }
    if (roleHeader === 'ADMIN') {
      req.auth = { userId: 'user-admin', role: 'ADMIN', department: deptHeader ?? null, sessionId: 'sess-3' };
      return next();
    }
    return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sessão inválida.' } });
  },
  requirePermission: (permission: string) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const role = req.auth?.role;
    // Permissões conforme permissions.ts:
    // VIEWER possui apenas cases:read, catalogs:read
    // ANALYST e ADMIN possuem cases:write
    if (permission === 'cases:write' && role === 'VIEWER') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Você não tem permissão para esta ação.' } });
    }
    return next();
  },
  requireRole: (...roles: string[]) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!roles.includes(req.auth?.role ?? '')) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Acesso negado.' } });
    }
    return next();
  },
}));

vi.mock('../../lib/storage/index.js', () => ({
  getAttachmentStorage: () => ({
    save: vi.fn().mockResolvedValue([]),
    remove: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { sacRouter } from './sac.routes.js';

let server: Server | undefined;

async function request(path: string, init?: RequestInit) {
  const app = express();
  app.use(express.json());
  // Simula requireAuth globalmente antes de entrar em sacRouter
  const { requireAuth } = await import('../auth/auth.middleware.js');
  app.use('/sac-records', requireAuth, sacRouter);
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ZodError || error?.name === 'ZodError') return res.status(422).json({ error: { code: 'VALIDATION_ERROR', details: error.issues } });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: error?.message } });
  });
  server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server unavailable');
  return fetch(`http://127.0.0.1:${address.port}${path}`, init);
}

describe('Rotas de SAC e Permissões de Tratativa (sac.routes.ts)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    server?.close();
  });

  it('perfil Consulta (VIEWER) recebe 403 Forbidden ao tentar gravar tratativa via PATCH direta', async () => {
    const res = await request('/sac-records/sac-123/treatment', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-test-role': 'VIEWER',
      },
      body: JSON.stringify({
        updatedAt: new Date().toISOString(),
        solutionSummary: 'Tentativa indevida de tratativa por usuário de consulta',
      }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
    expect(mockSacService.updateSacTreatment).not.toHaveBeenCalled();
  });

  it('perfil Analista (ANALYST) consegue gravar tratativa com sucesso', async () => {
    const fakeUpdated = {
      id: 'sac-123',
      solutionSummary: 'Tratativa gravada pelo analista com sucesso',
      identifiedCause: 'Falha no fornecedor',
      status: 'IN_PROGRESS',
    };
    mockSacService.updateSacTreatment.mockResolvedValue(fakeUpdated);

    const now = new Date().toISOString();
    const res = await request('/sac-records/sac-123/treatment', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-test-role': 'ANALYST',
      },
      body: JSON.stringify({
        updatedAt: now,
        solutionSummary: 'Tratativa gravada pelo analista com sucesso',
        identifiedCause: 'Falha no fornecedor',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe('sac-123');
    expect(mockSacService.updateSacTreatment).toHaveBeenCalledWith(
      'sac-123',
      expect.objectContaining({
        solutionSummary: 'Tratativa gravada pelo analista com sucesso',
        identifiedCause: 'Falha no fornecedor',
      }),
      'user-analyst',
      'ANALYST',
      'SAC'
    );
  });

  it('perfil Consulta (VIEWER) consegue ler os dados do caso incluindo a tratativa (GET)', async () => {
    const fakeRecord = {
      id: 'sac-123',
      ticket: 'SAC-2026-0001',
      status: 'IN_PROGRESS',
      solutionSummary: 'Tratativa e resposta fornecida ao cliente',
      identifiedCause: 'Instabilidade operacional',
      responsibleArea: 'Suporte',
      correctiveAction: 'Correção de rotina',
      customer: { name: 'Cliente Teste' },
      items: [],
      attachments: [],
    };
    mockSacService.getSacRecord.mockResolvedValue(fakeRecord);

    const res = await request('/sac-records/sac-123', {
      method: 'GET',
      headers: {
        'x-test-role': 'VIEWER',
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.ticket).toBe('SAC-2026-0001');
    expect(body.data.solutionSummary).toBe('Tratativa e resposta fornecida ao cliente');
    expect(body.data.identifiedCause).toBe('Instabilidade operacional');
    expect(mockSacService.getSacRecord).toHaveBeenCalledWith('sac-123', 'VIEWER', null);
  });

  it('rejeita criação com payload inválido ou datas invertidas via validação Zod da API (422)', async () => {
    // Falha 1: Sem campos obrigatórios
    const resEmpty = await request('/sac-records', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-role': 'ADMIN',
        'Idempotency-Key': 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      },
      body: JSON.stringify({}),
    });
    expect(resEmpty.status).toBe(422);

    // Falha 2: dueAt anterior a openedAt
    const resInvertedDates = await request('/sac-records', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-role': 'ADMIN',
        'Idempotency-Key': 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12',
      },
      body: JSON.stringify({
        customerName: 'Cliente Teste',
        channelId: 'ch-1',
        reasonId: 're-1',
        description: 'Descrição válida com mais de 10 caracteres',
        priority: 'MEDIUM',
        openedAt: '2026-09-10T10:00:00.000Z',
        dueAt: '2026-09-01T10:00:00.000Z', // anterior à abertura!
        items: [],
      }),
    });
    expect(resInvertedDates.status).toBe(422);
  });

  it('bloqueia perfil Consulta (VIEWER) e Analista (ANALYST) ao tentar revelar documento sensível (403)', async () => {
    const resViewer = await request('/sac-records/sac-123/reveal-sensitive', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-role': 'VIEWER',
      },
      body: JSON.stringify({ field: 'customerDocument' }),
    });
    expect(resViewer.status).toBe(403);

    const resAnalyst = await request('/sac-records/sac-123/reveal-sensitive', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-role': 'ANALYST',
      },
      body: JSON.stringify({ field: 'customerDocument' }),
    });
    expect(resAnalyst.status).toBe(403);
    expect(mockSacService.revealSacRecordSensitive).not.toHaveBeenCalled();
  });

  it('valida e processa alteração de status em POST /sac-records/:id/status', async () => {
    mockSacService.changeSacStatus.mockResolvedValue({ id: 'sac-123', status: 'IN_PROGRESS' });

    // Cenário de erro anterior: payload sem 'status' falha com 422 VALIDATION_ERROR
    const resWithoutStatus = await request('/sac-records/sac-123/status', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-role': 'ADMIN',
      },
      body: JSON.stringify({ updatedAt: '2026-10-02T10:00:00.000Z' }),
    });
    expect(resWithoutStatus.status).toBe(422);
    const bodyError = await resWithoutStatus.json();
    expect(bodyError.error.code).toBe('VALIDATION_ERROR');

    // Cenário corrigido: "Iniciar atendimento" envia status IN_PROGRESS e updatedAt
    const resStart = await request('/sac-records/sac-123/status', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-role': 'ADMIN',
      },
      body: JSON.stringify({
        updatedAt: '2026-10-02T10:00:00.000Z',
        status: 'IN_PROGRESS',
        assumeIfUnassigned: false,
      }),
    });
    expect(resStart.status).toBe(200);
    expect(mockSacService.changeSacStatus).toHaveBeenCalledWith(
      'sac-123',
      expect.objectContaining({
        status: 'IN_PROGRESS',
        assumeIfUnassigned: false,
      }),
      'user-admin',
      'ADMIN',
      null
    );

    // VIEWER recebe 403 Forbidden
    const resViewer = await request('/sac-records/sac-123/status', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-role': 'VIEWER',
      },
      body: JSON.stringify({
        updatedAt: '2026-10-02T10:00:00.000Z',
        status: 'IN_PROGRESS',
      }),
    });
    expect(resViewer.status).toBe(403);
  });

  describe('Exclusão de Registros SAC (DELETE /:id e POST /:id/delete)', () => {
    const validPayload = {
      updatedAt: '2026-10-05T12:00:00.000Z',
      justification: 'Registro cadastrado em duplicidade no sistema',
    };

    it('bloqueia perfil Consulta (VIEWER) com 403 em DELETE e POST /delete', async () => {
      const resDelete = await request('/sac-records/sac-123', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'x-test-role': 'VIEWER' },
        body: JSON.stringify(validPayload),
      });
      expect(resDelete.status).toBe(403);

      const resPost = await request('/sac-records/sac-123/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-role': 'VIEWER' },
        body: JSON.stringify(validPayload),
      });
      expect(resPost.status).toBe(403);
      expect(mockSacService.deleteSacRecord).not.toHaveBeenCalled();
    });

    it('bloqueia perfil Analista (ANALYST) com 403 em DELETE e POST /delete', async () => {
      const resDelete = await request('/sac-records/sac-123', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'x-test-role': 'ANALYST' },
        body: JSON.stringify(validPayload),
      });
      expect(resDelete.status).toBe(403);

      const resPost = await request('/sac-records/sac-123/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-role': 'ANALYST' },
        body: JSON.stringify(validPayload),
      });
      expect(resPost.status).toBe(403);
      expect(mockSacService.deleteSacRecord).not.toHaveBeenCalled();
    });

    it('valida payload de exclusão e rejeita justificativa curta ou ausente (422)', async () => {
      const resShort = await request('/sac-records/sac-123', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'x-test-role': 'ADMIN' },
        body: JSON.stringify({ updatedAt: '2026-10-05T12:00:00.000Z', justification: 'abc' }),
      });
      expect(resShort.status).toBe(422);

      const resNoDate = await request('/sac-records/sac-123', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'x-test-role': 'ADMIN' },
        body: JSON.stringify({ justification: 'Justificativa válida com mais de 5 caracteres' }),
      });
      expect(resNoDate.status).toBe(422);
    });

    it('permite exclusão exclusiva para perfil ADMIN via DELETE e POST /delete', async () => {
      mockSacService.deleteSacRecord.mockResolvedValue({
        id: 'sac-123',
        ticket: 'SAC-2026-0001',
        deletedAt: '2026-10-05T15:00:00.000Z',
      });

      // Via DELETE
      const resDelete = await request('/sac-records/sac-123', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'x-test-role': 'ADMIN' },
        body: JSON.stringify(validPayload),
      });
      expect(resDelete.status).toBe(200);
      const bodyDelete = await resDelete.json();
      expect(bodyDelete.data.id).toBe('sac-123');
      expect(mockSacService.deleteSacRecord).toHaveBeenCalledWith(
        'sac-123',
        expect.objectContaining({
          justification: 'Registro cadastrado em duplicidade no sistema',
        }),
        'user-admin',
        'ADMIN',
        null
      );

      // Via POST /delete
      const resPost = await request('/sac-records/sac-123/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-role': 'ADMIN' },
        body: JSON.stringify(validPayload),
      });
      expect(resPost.status).toBe(200);
    });

    it('propaga erro de concorrência 409 quando o caso foi alterado concorrentemente', async () => {
      mockSacService.deleteSacRecord.mockRejectedValue(
        new mockSacService.SacRecordError(
          'CONFLICT',
          'O registro foi alterado por outro usuário. Recarregue os dados antes de prosseguir.',
          409
        )
      );

      const res = await request('/sac-records/sac-123', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'x-test-role': 'ADMIN' },
        body: JSON.stringify(validPayload),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe('CONFLICT');
    });
  });
});

