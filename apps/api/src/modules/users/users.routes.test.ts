import express from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  const database = {
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    sacRecord: {
      findMany: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    activityLog: { create: vi.fn() },
    notification: { create: vi.fn(), deleteMany: vi.fn() },
    adminAudit: { create: vi.fn() },
    authSession: { updateMany: vi.fn(), deleteMany: vi.fn() },
    $executeRaw: vi.fn(),
  };
  const transaction = vi.fn(async (input: unknown, _options?: unknown) =>
    typeof input === 'function' ? (input as (tx: typeof database) => unknown)(database) : Promise.all(input as Promise<unknown>[])
  );
  return { database, transaction };
});

vi.mock('../../lib/prisma.js', () => ({
  prisma: { ...mock.database, $transaction: mock.transaction },
}));

import { hasPermission, type Permission } from '../../domain/permissions.js';

vi.mock('../auth/auth.middleware.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const actorId = (req.headers['x-actor-id'] as string) || 'admin-1';
    const actorRole = ((req.headers['x-actor-role'] as string) || 'ADMIN') as any;
    req.auth = { userId: actorId, role: actorRole, sessionId: 'sess-admin' };
    next();
  },
  requirePermission: (permission: Permission) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (hasPermission(req.auth!.role, permission)) return next();
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Você não tem permissão para esta ação.' } });
  },
}));

import { ZodError } from 'zod';
import { usersRouter } from './users.routes.js';

let server: Server | undefined;
async function request(path: string, init: RequestInit) {
  const app = express();
  app.use(express.json());
  app.use('/users', usersRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    if (err instanceof ZodError) return res.status(422).json({ error: { code: 'VALIDATION_ERROR', details: err.issues } });
    res.status(err.status || 500).json({ error: { code: err.code || 'ERROR', message: err.message } });
  });
  server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server unavailable');
  return fetch(`http://127.0.0.1:${address.port}${path}`, init);
}

describe('rotas diretas de gestão de equipe e exclusão de usuário (users.routes)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.database.$executeRaw.mockResolvedValue(1);
    mock.database.authSession.deleteMany.mockResolvedValue({ count: 1 });
    mock.database.notification.deleteMany.mockResolvedValue({ count: 0 });
    mock.database.adminAudit.create.mockResolvedValue({});
    mock.database.user.update.mockResolvedValue({ id: 'analyst-1', name: 'Usuário Excluído' });
    mock.database.user.delete.mockResolvedValue({ id: 'analyst-1' });
    mock.database.sacRecord.update.mockResolvedValue({});
    mock.database.activityLog.create.mockResolvedValue({});
    mock.database.notification.create.mockResolvedValue({});
  });

  afterEach(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
  });

  describe('Proteções de administrador em chamadas diretas de exclusão', () => {
    it('rejeita autoexclusão com status 403 (SELF_ACTION_BLOCKED) via DELETE', async () => {
      mock.database.user.findUnique.mockResolvedValue({
        id: 'admin-1',
        role: 'ADMIN',
        deletedAt: null,
      });

      const response = await request('/users/admin-1', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'x-actor-id': 'admin-1' },
      });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body).toEqual({
        error: {
          code: 'SELF_ACTION_BLOCKED',
          message: 'Não é permitido executar ações administrativas na própria conta.',
        },
      });
    });

    it('rejeita autoexclusão com status 403 (SELF_ACTION_BLOCKED) via POST /:id/delete', async () => {
      mock.database.user.findUnique.mockResolvedValue({
        id: 'admin-1',
        role: 'ADMIN',
        deletedAt: null,
      });

      const response = await request('/users/admin-1/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-actor-id': 'admin-1' },
      });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body).toEqual({
        error: {
          code: 'SELF_ACTION_BLOCKED',
          message: 'Não é permitido executar ações administrativas na própria conta.',
        },
      });
    });

    it('rejeita exclusão de outro administrador com status 403 (ADMIN_PROTECTION) via DELETE', async () => {
      mock.database.user.findUnique.mockResolvedValue({
        id: 'admin-2',
        role: 'ADMIN',
        deletedAt: null,
      });

      const response = await request('/users/admin-2', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'x-actor-id': 'admin-1' },
      });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body).toEqual({
        error: {
          code: 'ADMIN_PROTECTION',
          message: 'Não é permitido excluir outro administrador.',
        },
      });
    });

    it('rejeita exclusão de outro administrador com status 403 (ADMIN_PROTECTION) via POST /:id/delete', async () => {
      mock.database.user.findUnique.mockResolvedValue({
        id: 'admin-2',
        role: 'ADMIN',
        deletedAt: null,
      });

      const response = await request('/users/admin-2/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-actor-id': 'admin-1' },
      });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body).toEqual({
        error: {
          code: 'ADMIN_PROTECTION',
          message: 'Não é permitido excluir outro administrador.',
        },
      });
    });
  });

  describe('Destino obrigatório de casos abertos em chamadas diretas de exclusão', () => {
    it('exige estratégia de destino quando há casos abertos atribuídos (status 422 CASE_DESTINATION_REQUIRED)', async () => {
      mock.database.user.findUnique.mockResolvedValue({
        id: 'analyst-1',
        role: 'ANALYST',
        deletedAt: null,
        _count: { assignedCases: 1 },
      });
      mock.database.sacRecord.findMany.mockResolvedValue([{ id: 'case-1', ticket: 'SAC-1' }]);

      const response = await request('/users/analyst-1', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'x-actor-id': 'admin-1' },
        body: JSON.stringify({}),
      });
      const body = await response.json();

      expect(response.status).toBe(422);
      expect(body).toEqual({
        error: {
          code: 'CASE_DESTINATION_REQUIRED',
          message: 'Escolha o destino dos casos abertos antes de excluir.',
        },
      });
    });

    it('rejeita estratégia transfer sem responsável de destino válido (status 422 INVALID_TRANSFER_TARGET)', async () => {
      mock.database.user.findUnique.mockResolvedValue({
        id: 'analyst-1',
        role: 'ANALYST',
        deletedAt: null,
        _count: { assignedCases: 1 },
      });
      mock.database.sacRecord.findMany.mockResolvedValue([{ id: 'case-1', ticket: 'SAC-1' }]);

      const response = await request('/users/analyst-1', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'x-actor-id': 'admin-1' },
        body: JSON.stringify({ strategy: 'transfer', transferToUserId: '' }),
      });
      const body = await response.json();

      expect(response.status).toBe(422);
      expect(body.error.code).toBe('INVALID_TRANSFER_TARGET');
    });

    it('rejeita estratégia unassigned sem confirmação explícita (status 422 UNASSIGN_CONFIRMATION_REQUIRED)', async () => {
      mock.database.user.findUnique.mockResolvedValue({
        id: 'analyst-1',
        role: 'ANALYST',
        deletedAt: null,
        _count: { assignedCases: 1 },
      });
      mock.database.sacRecord.findMany.mockResolvedValue([{ id: 'case-1', ticket: 'SAC-1' }]);

      const response = await request('/users/analyst-1', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'x-actor-id': 'admin-1' },
        body: JSON.stringify({ strategy: 'unassigned', confirmUnassigned: false }),
      });
      const body = await response.json();

      expect(response.status).toBe(422);
      expect(body).toEqual({
        error: {
          code: 'UNASSIGN_CONFIRMATION_REQUIRED',
          message: 'Confirme que os casos ficarão sem responsável.',
        },
      });
    });

    it('conclui exclusão com sucesso quando estratégia transfer é válida e responsável informado', async () => {
      mock.database.user.findUnique.mockResolvedValue({
        id: 'analyst-1',
        name: 'Analista Excluir',
        email: 'analista@sac.local',
        role: 'ANALYST',
        deletedAt: null,
        _count: { assignedCases: 1, comments: 2, createdCases: 0 },
      });
      mock.database.sacRecord.findMany.mockResolvedValue([{ id: 'case-1', ticket: 'SAC-1' }]);
      mock.database.user.findFirst.mockResolvedValue({ id: 'analyst-2', name: 'Outro Analista' });
      mock.database.sacRecord.count.mockResolvedValue(1);

      const response = await request('/users/analyst-1', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'x-actor-id': 'admin-1' },
        body: JSON.stringify({
          strategy: 'transfer',
          transferToUserId: 'analyst-2',
          justification: 'Transferência e exclusão válida.',
        }),
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data).toMatchObject({
        deleted: true,
        mode: 'anonymized',
      });
      expect(mock.database.sacRecord.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'case-1' },
          data: expect.objectContaining({ assigneeId: 'analyst-2' }),
        })
      );
    });
  });

  describe('Descontinuação de chamadas diretas às rotas de desativação e reativação', () => {
    it('chamar POST /users/:id/deactivate diretamente retorna HTTP 410 (DEACTIVATION_DISCONTINUED)', async () => {
      mock.database.user.findUnique.mockResolvedValue({
        id: 'analyst-1',
        role: 'ANALYST',
        deletedAt: null,
      });

      const response = await request('/users/analyst-1/deactivate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-actor-id': 'admin-1' },
        body: JSON.stringify({ justification: 'Tentativa de inativar.' }),
      });
      const body = await response.json();

      expect(response.status).toBe(410);
      expect(body).toEqual({
        error: {
          code: 'DEACTIVATION_DISCONTINUED',
          message: 'A inativação de usuários foi descontinuada. O fluxo de gestão de equipe agora utiliza exclusão de usuários.',
        },
      });
    });

    it('POST /users/:id/deactivate na própria conta respeita proteção de admin (status 403 SELF_ACTION_BLOCKED)', async () => {
      mock.database.user.findUnique.mockResolvedValue({
        id: 'admin-1',
        role: 'ADMIN',
        deletedAt: null,
      });

      const response = await request('/users/admin-1/deactivate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-actor-id': 'admin-1' },
        body: JSON.stringify({ justification: 'Tentativa auto.' }),
      });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error.code).toBe('SELF_ACTION_BLOCKED');
    });

    it('chamar POST /users/:id/reactivate diretamente retorna HTTP 410 (REACTIVATION_DISCONTINUED)', async () => {
      mock.database.user.findUnique.mockResolvedValue({
        id: 'analyst-1',
        role: 'ANALYST',
        deletedAt: null,
      });

      const response = await request('/users/analyst-1/reactivate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-actor-id': 'admin-1' },
        body: JSON.stringify({ justification: 'Tentativa de reativar.' }),
      });
      const body = await response.json();

      expect(response.status).toBe(410);
      expect(body).toEqual({
        error: {
          code: 'REACTIVATION_DISCONTINUED',
          message: 'A reativação de usuários foi descontinuada. O fluxo de gestão de equipe agora utiliza exclusão de usuários.',
        },
      });
    });

    it('POST /users/:id/reactivate em outro administrador respeita proteção (status 403 ADMIN_PROTECTION)', async () => {
      mock.database.user.findUnique.mockResolvedValue({
        id: 'admin-2',
        role: 'ADMIN',
        deletedAt: null,
      });

      const response = await request('/users/admin-2/reactivate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-actor-id': 'admin-1' },
        body: JSON.stringify({ justification: 'Tentativa em outro admin.' }),
      });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error.code).toBe('ADMIN_PROTECTION');
    });
  });

  describe('Autorização no backend e bloqueio de perfis não-administradores (requirePermission)', () => {
    it('rejeita alteração de perfil solicitada por analista com HTTP 403 (FORBIDDEN)', async () => {
      const response = await request('/users/analyst-1/role', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-actor-id': 'analyst-current', 'x-actor-role': 'ANALYST' },
        body: JSON.stringify({ role: 'VIEWER', justification: 'Tentativa não autorizada.' }),
      });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body).toEqual({
        error: {
          code: 'FORBIDDEN',
          message: 'Você não tem permissão para esta ação.',
        },
      });
    });

    it('rejeita exclusão de usuário solicitada por analista com HTTP 403 (FORBIDDEN)', async () => {
      const response = await request('/users/analyst-1', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'x-actor-id': 'analyst-current', 'x-actor-role': 'ANALYST' },
      });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body).toEqual({
        error: {
          code: 'FORBIDDEN',
          message: 'Você não tem permissão para esta ação.',
        },
      });
    });

    it('rejeita exclusão via POST /delete solicitada por consulta com HTTP 403 (FORBIDDEN)', async () => {
      const response = await request('/users/analyst-1/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-actor-id': 'viewer-current', 'x-actor-role': 'VIEWER' },
      });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body).toEqual({
        error: {
          code: 'FORBIDDEN',
          message: 'Você não tem permissão para esta ação.',
        },
      });
    });

    it('rejeita aprovação de usuário solicitada por consulta com HTTP 403 (FORBIDDEN)', async () => {
      const response = await request('/users/pending-1/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-actor-id': 'viewer-current', 'x-actor-role': 'VIEWER' },
        body: JSON.stringify({ role: 'ANALYST' }),
      });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body).toEqual({
        error: {
          code: 'FORBIDDEN',
          message: 'Você não tem permissão para esta ação.',
        },
      });
    });

    it('rejeita cadastro de usuário solicitado por analista com HTTP 403 (FORBIDDEN)', async () => {
      const response = await request('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-actor-id': 'analyst-current', 'x-actor-role': 'ANALYST' },
        body: JSON.stringify({ name: 'Novo Analista', email: 'novo@empresa.com', role: 'ANALYST' }),
      });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body).toEqual({
        error: {
          code: 'FORBIDDEN',
          message: 'Você não tem permissão para esta ação.',
        },
      });
    });

    it('permite que qualquer usuário autenticado acesse /users/assignable', async () => {
      mock.database.user.findMany.mockResolvedValue([{ id: 'analyst-2', name: 'Analista Elegível' }]);

      const response = await request('/users/assignable', {
        method: 'GET',
        headers: { 'x-actor-id': 'analyst-current', 'x-actor-role': 'ANALYST' },
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data).toEqual([{ id: 'analyst-2', name: 'Analista Elegível' }]);
    });
  });

  describe('Proteções de administrador em chamadas diretas de alteração de perfil (PATCH /users/:id/role)', () => {
    it('rejeita alteração de perfil na própria conta com status 403 (SELF_ACTION_BLOCKED)', async () => {
      mock.database.user.findUnique.mockResolvedValue({
        id: 'admin-1',
        role: 'ADMIN',
        active: true,
        approvedAt: new Date(),
        rejectedAt: null,
      });

      const response = await request('/users/admin-1/role', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-actor-id': 'admin-1', 'x-actor-role': 'ADMIN' },
        body: JSON.stringify({ role: 'VIEWER', justification: 'Auto-rebaixamento.' }),
      });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error.code).toBe('SELF_ACTION_BLOCKED');
    });

    it('rejeita alteração de perfil de outro administrador com status 403 (ADMIN_PROTECTION)', async () => {
      mock.database.user.findUnique.mockResolvedValue({
        id: 'admin-2',
        role: 'ADMIN',
        active: true,
        approvedAt: new Date(),
        rejectedAt: null,
      });

      const response = await request('/users/admin-2/role', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-actor-id': 'admin-1', 'x-actor-role': 'ADMIN' },
        body: JSON.stringify({ role: 'VIEWER', justification: 'Tentativa em outro admin.' }),
      });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error.code).toBe('ADMIN_PROTECTION');
    });

    it('rejeita alteração de perfil para ADMIN com status 422 (VALIDATION_ERROR)', async () => {
      const response = await request('/users/analyst-1/role', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-actor-id': 'admin-1', 'x-actor-role': 'ADMIN' },
        body: JSON.stringify({ role: 'ADMIN' }),
      });
      const body = await response.json();

      expect(response.status).toBe(422);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
