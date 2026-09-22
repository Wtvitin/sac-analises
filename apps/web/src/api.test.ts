import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest, setSessionExpiredHandler } from './api';

function json(status: number, data: unknown) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }

describe('cliente HTTP com sessão por cookie', () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.stubGlobal('document', { cookie: 'sac_csrf=csrf-test-value' }); setSessionExpiredHandler(undefined); });

  it('não consulta armazenamentos de token e sempre inclui credenciais', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('storage must not be read'); } }); vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('storage must not be read'); } });
    const fetchMock = vi.fn().mockResolvedValue(json(200, { data: { ok: true } })); vi.stubGlobal('fetch', fetchMock);
    await expect(apiRequest('/health')).resolves.toEqual({ ok: true }); expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'include' });
  });

  it('compartilha uma única renovação entre leituras concorrentes e não entra em loop', async () => {
    let reads = 0; let refreshes = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { if (url.endsWith('/auth/refresh')) { refreshes += 1; return new Response(null, { status: 204 }); } reads += 1; return reads <= 2 ? json(401, { error: {} }) : json(200, { data: { ok: true } }); }));
    const results = await Promise.all([apiRequest('/one'), apiRequest('/two')]); expect(results).toEqual([{ ok: true }, { ok: true }]); expect(refreshes).toBe(1); expect(reads).toBe(4);
  });

  it('envia CSRF em mutações e nunca repete automaticamente uma mutação 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(401, { error: { message: 'Sessão inválida.' } })); vi.stubGlobal('fetch', fetchMock);
    await expect(apiRequest('/mutable', { method: 'POST', body: '{}' })).rejects.toThrow('Sessão inválida.');
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ 'X-CSRF-Token': 'csrf-test-value' });
  });

  it('encerra o estado autenticado quando a renovação falha', async () => {
    const expired = vi.fn(); setSessionExpiredHandler(expired); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(401, { error: {} })));
    await expect(apiRequest('/protected')).rejects.toThrow(/sessão expirou/i); expect(expired).toHaveBeenCalledTimes(1);
  });
});
