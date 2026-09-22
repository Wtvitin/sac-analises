import express from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  getAnalyticsDashboard: vi.fn(),
  streamAnalyticsCsv: vi.fn(),
}));

vi.mock('./analytics.service.js', () => ({
  getAnalyticsDashboard: mock.getAnalyticsDashboard,
  streamAnalyticsCsv: mock.streamAnalyticsCsv,
  ANALYTICS_TIME_ZONE: 'America/Sao_Paulo',
}));

// Mock requireAuth to inject mock user
vi.mock('../auth/auth.middleware.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const authHeader = req.headers.authorization;
    if (authHeader === 'Bearer valid-token') {
      req.auth = { userId: 'user-1', role: 'ADMIN', sessionId: 'sess-1' };
      return next();
    }
    return _res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
  },
  requirePermission: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

import { analyticsRouter } from './analytics.routes.js';

let server: Server | undefined;
async function request(path: string, init?: RequestInit) {
  const app = express();
  app.use(express.json());
  app.use('/analytics', analyticsRouter);
  server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server unavailable');
  return fetch(`http://127.0.0.1:${address.port}${path}`, init);
}

describe('analytics HTTP routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
  });

  it('exige autenticação para acessar dashboard e exportação', async () => {
    const respDash = await request('/analytics/dashboard');
    expect(respDash.status).toBe(401);

    const respExp = await request('/analytics/export');
    expect(respExp.status).toBe(401);
  });

  it('retorna dados do dashboard com filtros validados', async () => {
    mock.getAnalyticsDashboard.mockResolvedValue({
      isEmptyDatabase: false,
      metrics: { currentPending: 5 },
    });

    const resp = await request('/analytics/dashboard?period=30d', {
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.data).toEqual({
      isEmptyDatabase: false,
      metrics: { currentPending: 5 },
    });
    expect(mock.getAnalyticsDashboard).toHaveBeenCalledWith(expect.objectContaining({ period: '30d' }));
  });

  it('rejeita períodos personalizados com datas invertidas', async () => {
    const resp = await request('/analytics/dashboard?period=custom&startDate=2026-09-20&endDate=2026-09-10', {
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(resp.status).toBe(422);
  });

  it('transmite relatório CSV com cabeçalhos e encoding corretos', async () => {
    async function* fakeStream() {
      yield '\uFEFF';
      yield '"Ticket";"Cliente"\r\n';
      yield '"SAC-001";"Cliente Teste"\r\n';
    }
    mock.streamAnalyticsCsv.mockImplementation(fakeStream);

    const resp = await request('/analytics/export?period=7d', {
      headers: { Authorization: 'Bearer valid-token' },
    });

    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/csv');
    expect(resp.headers.get('content-disposition')).toMatch(/attachment; filename="sac-relatorio-operacional-7d-.*\.csv"/);
    const buffer = Buffer.from(await resp.arrayBuffer());
    // Check UTF-8 BOM bytes 0xEF, 0xBB, 0xBF
    expect(buffer[0]).toBe(0xEF);
    expect(buffer[1]).toBe(0xBB);
    expect(buffer[2]).toBe(0xBF);
    const text = buffer.toString('utf-8');
    expect(text).toContain('"Ticket";"Cliente"');
    expect(text).toContain('"SAC-001";"Cliente Teste"');
  });

  it('valida streaming de mais de 100 registros sem carregar tudo em memória', async () => {
    async function* largeStream() {
      yield '\uFEFF';
      yield '"Ticket";"Cliente"\r\n';
      for (let i = 1; i <= 150; i++) {
        yield `"SAC-${i}";"Cliente ${i}"\r\n`;
      }
    }
    mock.streamAnalyticsCsv.mockImplementation(largeStream);

    const resp = await request('/analytics/export?period=30d', {
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(resp.status).toBe(200);
    const text = await resp.text();
    expect(text).toContain('"SAC-150";"Cliente 150"');
    expect(text.split('\r\n').length).toBeGreaterThan(150);
  });
});
