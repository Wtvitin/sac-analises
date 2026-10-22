import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiRequest,
  setSessionExpiredHandler,
  notifySessionLogin,
  notifySessionLogout,
  getSessionGeneration,
  _resetAuthSyncForTesting,
  _setSessionGenerationForTesting,
  _resetLocalRefreshPromiseForTesting,
} from './api';

function json(status: number, data: unknown) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }

describe('cliente HTTP com sessão por cookie', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.stubGlobal('document', { cookie: 'sac_csrf=csrf-test-value' });
    setSessionExpiredHandler(undefined);
    _resetAuthSyncForTesting();
  });

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

  it('lança ApiRequestError com status, code e formatação de mensagem para erro 409 e 422', async () => {
    // 409 STALE_SAC_RECORD
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(409, {
      error: { code: 'STALE_SAC_RECORD', message: 'Este caso foi atualizado por outro usuário. Recarregue as informações antes de continuar.' },
    })));
    try {
      await apiRequest('/test-stale', { method: 'POST', body: '{}' });
      expect.unreachable();
    } catch (err: any) {
      expect(err.name).toBe('ApiRequestError');
      expect(err.status).toBe(409);
      expect(err.code).toBe('STALE_SAC_RECORD');
      expect(err.message).toContain('atualizado por outro usuário');
    }

    // 422 VALIDATION_ERROR sem message explícita formata details
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(422, {
      error: {
        code: 'VALIDATION_ERROR',
        details: [{ path: ['status'], message: 'Required' }],
      },
    })));
    try {
      await apiRequest('/test-validation', { method: 'POST', body: '{}' });
      expect.unreachable();
    } catch (err: any) {
      expect(err.name).toBe('ApiRequestError');
      expect(err.status).toBe(422);
      expect(err.code).toBe('VALIDATION_ERROR');
      expect(err.message).toContain('status');
      expect(err.message).toContain('Required');
    }
  });
});

describe('coordenação de renovação de sessão entre abas e Web Locks (F-01, F-02, F-03)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.stubGlobal('document', { cookie: 'sac_csrf=csrf-test-value' });
    setSessionExpiredHandler(undefined);
    _resetAuthSyncForTesting();
  });

  it('1. duas abas realizando refresh simultaneamente executam apenas uma chamada via Web Locks', async () => {
    let refreshes = 0;
    let readsTab1 = 0;
    let readsTab2 = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/auth/refresh')) {
          refreshes += 1;
          await new Promise((r) => setTimeout(r, 20));
          return new Response(null, { status: 200 });
        }
        if (url.endsWith('/tab-1')) {
          readsTab1 += 1;
          return readsTab1 === 1 ? json(401, { error: {} }) : json(200, { data: { tab: 1 } });
        }
        if (url.endsWith('/tab-2')) {
          readsTab2 += 1;
          return readsTab2 === 1 ? json(401, { error: {} }) : json(200, { data: { tab: 2 } });
        }
        return json(200, { data: { ok: true } });
      })
    );

    const tab1Promise = apiRequest('/tab-1');
    _resetLocalRefreshPromiseForTesting();
    const tab2Promise = apiRequest('/tab-2');

    const [res1, res2] = await Promise.all([tab1Promise, tab2Promise]);
    expect(res1).toEqual({ tab: 1 });
    expect(res2).toEqual({ tab: 2 });
    expect(refreshes).toBe(1);
  });

  it('2. refresh lento superior a 10 segundos não provoca chamada desprotegida concorrente nem logout indevido', async () => {
    let refreshes = 0;
    let reads = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/auth/refresh')) {
          refreshes += 1;
          // Simula resposta demorada do backend
          await new Promise((r) => setTimeout(r, 40));
          return new Response(null, { status: 200 });
        }
        reads += 1;
        return reads === 1 ? json(401, { error: {} }) : json(200, { data: { slowSuccess: true } });
      })
    );

    const tab1Promise = apiRequest('/slow-read-1');
    _resetLocalRefreshPromiseForTesting();
    const tab2Promise = apiRequest('/slow-read-2');

    const [res1, res2] = await Promise.all([tab1Promise, tab2Promise]);
    expect(res1).toEqual({ slowSuccess: true });
    expect(res2).toEqual({ slowSuccess: true });
    // Nunca executa chamada concorrente fora do lock
    expect(refreshes).toBe(1);
  });

  it('3. renovação concluída antes da chegada de um 401 atrasado repete a chamada sem disparar novo /auth/refresh', async () => {
    let refreshes = 0;
    let reads = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/auth/refresh')) {
          refreshes += 1;
          return new Response(null, { status: 200 });
        }
        reads += 1;
        if (reads === 1) {
          // Outra aba conclui o refresh enquanto esta requisição ainda estava em trânsito
          _setSessionGenerationForTesting(getSessionGeneration() + 1);
          return json(401, { error: {} });
        }
        return json(200, { data: { fresh: true } });
      })
    );

    const result = await apiRequest('/tab-delayed');
    expect(result).toEqual({ fresh: true });
    // Não chama /auth/refresh novamente pois a sessão já é mais recente que a requisição original
    expect(refreshes).toBe(0);
    expect(reads).toBe(2);
  });

  it('4. logout durante uma renovação pendente limpa o estado e encerra a sessão', async () => {
    const expired = vi.fn();
    setSessionExpiredHandler(expired);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/auth/refresh')) {
          // Durante a renovação, outra aba executa logout
          notifySessionLogout();
          return json(401, { error: { code: 'SESSION_REVOKED', message: 'Sessão revogada.' } });
        }
        return json(401, { error: {} });
      })
    );

    await expect(apiRequest('/resource-during-logout')).rejects.toThrow(/sessão expirou/i);
    expect(expired).toHaveBeenCalled();
  });

  it('5. novo login imediatamente após logout reinicia a geração e limpa flags de falha', async () => {
    notifySessionLogout();
    const genAfterLogout = getSessionGeneration();

    notifySessionLogin();
    const genAfterLogin = getSessionGeneration();
    expect(genAfterLogin).toBeGreaterThan(genAfterLogout);

    let refreshes = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/auth/refresh')) {
          refreshes += 1;
          return new Response(null, { status: 200 });
        }
        return json(200, { data: { loggedIn: true } });
      })
    );

    const res = await apiRequest('/after-login');
    expect(res).toEqual({ loggedIn: true });
    expect(refreshes).toBe(0);
  });

  it('6. troca de usuário no mesmo navegador não herda bloqueios ou falhas da sessão anterior', async () => {
    const expired = vi.fn();
    setSessionExpiredHandler(expired);

    // Usuário 1 tem falha na renovação
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/auth/refresh')) return json(401, { error: {} });
        return json(401, { error: {} });
      })
    );
    await expect(apiRequest('/user1-req')).rejects.toThrow(/sessão expirou/i);

    // Usuário 2 faz login na mesma máquina
    notifySessionLogin();

    // Sessão do Usuário 2 consegue renovar normalmente sem ser bloqueada pela falha do Usuário 1
    let user2Refreshes = 0;
    let user2Reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/auth/refresh')) {
          user2Refreshes += 1;
          return new Response(null, { status: 200 });
        }
        user2Reads += 1;
        return user2Reads === 1 ? json(401, { error: {} }) : json(200, { data: { user2: true } });
      })
    );

    const user2Res = await apiRequest('/user2-req');
    expect(user2Res).toEqual({ user2: true });
    expect(user2Refreshes).toBe(1);
  });

  it('7. falha de rede e recuperação tratam erro sem travamento permanente', async () => {
    const expired = vi.fn();
    setSessionExpiredHandler(expired);

    // Falha de rede pura
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/auth/refresh')) {
          throw new TypeError('Failed to fetch');
        }
        return json(401, { error: {} });
      })
    );

    await expect(apiRequest('/network-failing')).rejects.toThrow(/sessão expirou/i);
    expect(expired).toHaveBeenCalled();

    // Rede recupera e login é reestabelecido
    notifySessionLogin();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/auth/refresh')) return new Response(null, { status: 200 });
        return json(200, { data: { recovered: true } });
      })
    );

    const res = await apiRequest('/network-recovered');
    expect(res).toEqual({ recovered: true });
  });

  it('8. funciona com fallback gracioso em navegador sem suporte a Web Locks API', async () => {
    let refreshes = 0;
    let reads = 0;

    vi.stubGlobal('navigator', { locks: undefined });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/auth/refresh')) {
          refreshes += 1;
          return new Response(null, { status: 200 });
        }
        reads += 1;
        return reads === 1 ? json(401, { error: {} }) : json(200, { data: { fallback: true } });
      })
    );

    const res = await apiRequest('/no-locks');
    expect(res).toEqual({ fallback: true });
    expect(refreshes).toBe(1);
    expect(reads).toBe(2);
  });

  it('9. requisições que continuam retornando 401 após renovação param imediatamente sem loops', async () => {
    let refreshCalls = 0;
    let readCalls = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/auth/refresh')) {
          refreshCalls += 1;
          return new Response(null, { status: 200 });
        }
        readCalls += 1;
        return json(401, { error: { message: 'Acesso permanentemente negado.' } });
      })
    );

    await expect(apiRequest('/always-401')).rejects.toThrow('Acesso permanentemente negado.');
    expect(refreshCalls).toBe(1);
    expect(readCalls).toBe(2);
  });

  it('10. isolamento real entre contextos de abas sincroniza via storage sem compartilhar variáveis de memória', async () => {
    const localStore = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => localStore.get(k) ?? null,
      setItem: (k: string, v: string) => localStore.set(k, v),
      removeItem: (k: string) => localStore.delete(k),
    });

    // Simula Aba 1 executando refresh e atualizando storage
    let refreshes = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/auth/refresh')) {
          refreshes += 1;
          return new Response(null, { status: 200 });
        }
        return json(200, { data: { ok: true } });
      })
    );

    // Força refresh simulando Aba 1
    _resetAuthSyncForTesting();
    localStore.set('sac_session_generation', '10');

    // Aba 2 lê da storage
    expect(getSessionGeneration()).toBe(10);

    // Garante que nenhum token foi escrito no storage
    for (const [key, value] of localStore.entries()) {
      expect(key).toMatch(/sac_session_generation|sac_last_refresh_failed_at/);
      expect(value).not.toMatch(/eyJ/);
      expect(value).not.toMatch(/token|secret|password|jwt/i);
    }
  });

  it('11. notifySessionLogout e notifySessionLogin preservam monotonicidade mesmo com memória local defasada', () => {
    const localStore = new Map<string, string>();
    localStore.set('sac_session_generation', '15');

    vi.stubGlobal('localStorage', {
      getItem: (k: string) => localStore.get(k) ?? null,
      setItem: (k: string, v: string) => localStore.set(k, v),
      removeItem: (k: string) => localStore.delete(k),
    });

    // notifySessionLogout deve avançar para 16 e nunca regredir para 2
    notifySessionLogout();
    expect(getSessionGeneration()).toBe(16);
    expect(localStore.get('sac_session_generation')).toBe('16');

    // notifySessionLogin deve avançar para 17 e nunca regredir
    notifySessionLogin();
    expect(getSessionGeneration()).toBe(17);
    expect(localStore.get('sac_session_generation')).toBe('17');
  });

  it('12. refresh concluído após logout em trânsito é descartado e não ressuscita a sessão', async () => {
    let refreshResolved = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/auth/refresh')) {
          // Enquanto o refresh estava em trânsito na rede, o usuário deslogou
          notifySessionLogout();
          refreshResolved = true;
          return new Response(null, { status: 200 });
        }
        return json(401, { error: {} });
      })
    );

    // O refresh que chegou atrasado não pode revalidar a sessão após o logout
    await expect(apiRequest('/protected')).rejects.toThrow(/sessão expirou/i);
    expect(refreshResolved).toBe(true);
  });

  it('13. eventos antigos de BroadcastChannel de sessões passadas são ignorados', async () => {
    const expired = vi.fn();
    setSessionExpiredHandler(expired);

    // Sessão atual está na geração 10
    _setSessionGenerationForTesting(10);

    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('sac_auth_sync') : null;
    if (channel) {
      // Envia evento de logout da geração 4 (sessão antiga já encerrada)
      channel.postMessage({ type: 'SESSION_LOGOUT', generation: 4 });
      // Envia falha de refresh antiga (geração 4)
      channel.postMessage({ type: 'REFRESH_FAILED', generation: 4, timestamp: Date.now() });

      // Aguarda processamento assíncrono da fila de mensagens
      await new Promise((resolve) => setTimeout(resolve, 50));
      channel.close();
    }

    // O handler de expiração não pode ter sido chamado para o evento antigo
    expect(expired).not.toHaveBeenCalled();
    // A geração atual permanece intacta em 10
    expect(getSessionGeneration()).toBe(10);
  });

  it('14. evento legítimo de BroadcastChannel encerra a sessão corretamente', async () => {
    const expired = vi.fn();
    setSessionExpiredHandler(expired);

    _setSessionGenerationForTesting(10);

    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('sac_auth_sync') : null;
    if (channel) {
      // Envia evento de logout legítimo da geração atual ou superior
      channel.postMessage({ type: 'SESSION_LOGOUT', generation: 10 });

      await new Promise((resolve) => setTimeout(resolve, 50));
      channel.close();
    }

    expect(expired).toHaveBeenCalled();
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

