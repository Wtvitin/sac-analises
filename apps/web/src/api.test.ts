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

describe('downloadFile - download autenticado e seguro', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('baixa o arquivo criando link temporário com nome extraído do Content-Disposition RFC 5987', async () => {
    const clickMock = vi.fn();
    const fakeAnchor = { href: '', download: '', click: clickMock };
    const appendChildMock = vi.fn();
    const removeChildMock = vi.fn();
    const createObjectURLMock = vi.fn().mockReturnValue('blob:test-url');
    const revokeObjectURLMock = vi.fn();

    vi.stubGlobal('URL', { createObjectURL: createObjectURLMock, revokeObjectURL: revokeObjectURLMock });
    vi.stubGlobal('window', { URL: { createObjectURL: createObjectURLMock, revokeObjectURL: revokeObjectURLMock } });
    vi.stubGlobal('document', {
      cookie: 'sac_csrf=csrf-test-value',
      createElement: vi.fn().mockImplementation((tag: string) => (tag === 'a' ? fakeAnchor : {})),
      body: {
        appendChild: appendChildMock,
        removeChild: removeChildMock,
      },
    });

    const headers = new Headers();
    headers.set('content-disposition', "attachment; filename=\"relatorio.pdf\"; filename*=UTF-8''relat%C3%B3rio%20final.pdf");
    const fakeBlob = new Blob(['%PDF-1.4 test'], { type: 'application/pdf' });
    const response = new Response(fakeBlob, { status: 200, headers });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const { downloadFile } = await import('./api');
    await downloadFile('/attachments/att-1/download', 'fallback.pdf');

    expect(createObjectURLMock).toHaveBeenCalled();
    expect(fakeAnchor.download).toBe('relatório final.pdf');
    expect(clickMock).toHaveBeenCalled();
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:test-url');
  });

  it('lança erro legível quando o download retorna erro 404', async () => {
    const response = new Response(JSON.stringify({ error: { message: 'Evidência não encontrada.' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const { downloadFile } = await import('./api');
    await expect(downloadFile('/attachments/missing/download')).rejects.toThrow('Evidência não encontrada.');
  });
});
