export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3333';
export type AuthUser = { id: string; name: string; email: string; role: 'ADMIN' | 'ANALYST' | 'VIEWER'; department?: string | null; active: boolean; approvedAt: string | null; timezone: string; lastLoginAt: string | null; mustChangePassword?: boolean };
export const DEFAULT_USER_DEPARTMENTS = [
  'Estoque',
  'Controle de Qualidade',
  'Qualidade',
  'Recebimento',
  'Almoxarifado',
  'Compras',
] as const;
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const AUTH_LOCK_NAME = 'sac_auth_refresh';
const AUTH_CHANNEL_NAME = 'sac_auth_sync';
const AUTH_GENERATION_KEY = 'sac_session_generation';
const AUTH_FAILED_KEY = 'sac_last_refresh_failed_at';

let refreshPromise: Promise<void> | null = null;
let sessionExpiredHandler: (() => void) | undefined;
let inMemoryGeneration = 1;
let inMemoryLastFailed = 0;

export function getSessionGeneration(): number {
  try {
    if (typeof localStorage !== 'undefined') {
      const val = localStorage.getItem(AUTH_GENERATION_KEY);
      if (val) {
        const parsed = parseInt(val, 10);
        if (!isNaN(parsed) && parsed > 0) return Math.max(parsed, inMemoryGeneration);
      }
    }
  } catch {
    // localStorage indisponível ou restrito
  }
  return inMemoryGeneration;
}

function setSessionGeneration(gen: number): number {
  const current = getSessionGeneration();
  const next = Math.max(current, gen);
  inMemoryGeneration = next;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(AUTH_GENERATION_KEY, String(next));
    }
  } catch {
    // localStorage indisponível ou restrito
  }
  return next;
}

function advanceSessionGeneration(): number {
  const current = getSessionGeneration();
  const next = current + 1;
  inMemoryGeneration = next;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(AUTH_GENERATION_KEY, String(next));
    }
  } catch {
    // localStorage indisponível ou restrito
  }
  return next;
}

let activeRefreshAbortController: AbortController | null = null;
let broadcastChannel: BroadcastChannel | null = null;
try {
  if (typeof BroadcastChannel !== 'undefined') {
    broadcastChannel = new BroadcastChannel(AUTH_CHANNEL_NAME);
    broadcastChannel.onmessage = (event) => {
      const { type, generation, timestamp } = event.data || {};
      const currentGen = getSessionGeneration();

      if (type === 'REFRESH_SUCCESS' && typeof generation === 'number') {
        if (generation > currentGen) {
          setSessionGeneration(generation);
          inMemoryLastFailed = 0;
        }
      } else if (type === 'REFRESH_FAILED' && typeof timestamp === 'number') {
        if (typeof generation !== 'number' || generation >= currentGen) {
          inMemoryLastFailed = Math.max(inMemoryLastFailed, timestamp);
        }
      } else if (type === 'SESSION_LOGOUT' && typeof generation === 'number') {
        if (generation >= currentGen) {
          setSessionGeneration(generation);
          inMemoryLastFailed = 0;
          refreshPromise = null;
          activeRefreshAbortController?.abort();
          activeRefreshAbortController = null;
          sessionExpiredHandler?.();
        }
      } else if (type === 'SESSION_LOGIN' && typeof generation === 'number') {
        if (generation >= currentGen) {
          setSessionGeneration(generation);
          inMemoryLastFailed = 0;
          refreshPromise = null;
        }
      }
    };
  }
} catch {
  // BroadcastChannel indisponível
}

export function notifySessionLogout() {
  activeRefreshAbortController?.abort();
  activeRefreshAbortController = null;
  refreshPromise = null;
  inMemoryLastFailed = 0;
  const newGen = advanceSessionGeneration();
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(AUTH_FAILED_KEY);
    }
  } catch {
    // ignore
  }
  try {
    broadcastChannel?.postMessage({ type: 'SESSION_LOGOUT', generation: newGen });
  } catch {
    // ignore
  }
}

export function notifySessionLogin() {
  activeRefreshAbortController?.abort();
  activeRefreshAbortController = null;
  refreshPromise = null;
  inMemoryLastFailed = 0;
  const newGen = advanceSessionGeneration();
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(AUTH_FAILED_KEY);
    }
  } catch {
    // ignore
  }
  try {
    broadcastChannel?.postMessage({ type: 'SESSION_LOGIN', generation: newGen });
  } catch {
    // ignore
  }
}

export function _resetAuthSyncForTesting() {
  activeRefreshAbortController?.abort();
  activeRefreshAbortController = null;
  inMemoryGeneration = 1;
  inMemoryLastFailed = 0;
  refreshPromise = null;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(AUTH_GENERATION_KEY);
      localStorage.removeItem(AUTH_FAILED_KEY);
      localStorage.removeItem('sac_last_refresh_at');
    }
  } catch {
    // ignore
  }
}

export function _setSessionGenerationForTesting(gen: number) {
  inMemoryGeneration = gen;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(AUTH_GENERATION_KEY, String(gen));
    }
  } catch {
    // ignore
  }
}

export function _resetLocalRefreshPromiseForTesting() {
  refreshPromise = null;
}

function csrfToken() {
  const entry = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith('sac_csrf='));
  if (!entry) return undefined;
  try { return decodeURIComponent(entry.slice('sac_csrf='.length)); } catch { return undefined; }
}

function requestHeaders(options: RequestInit, method: string) {
  const csrf = safeMethods.has(method) ? undefined : csrfToken();
  return {
    ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    ...options.headers,
  };
}

async function fetchApi(path: string, options: RequestInit) {
  const method = (options.method ?? 'GET').toUpperCase();
  return fetch(`${API_URL}${path}`, { ...options, method, credentials: 'include', headers: requestHeaders(options, method) });
}

async function performDirectRefresh(): Promise<void> {
  const startGen = getSessionGeneration();
  activeRefreshAbortController = new AbortController();
  try {
    const response = await fetchApi('/auth/refresh', {
      method: 'POST',
      signal: activeRefreshAbortController.signal,
    });
    if (!response.ok) {
      const now = Date.now();
      inMemoryLastFailed = now;
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(AUTH_FAILED_KEY, String(now));
        }
      } catch {}
      try {
        broadcastChannel?.postMessage({
          type: 'REFRESH_FAILED',
          generation: startGen,
          timestamp: now,
        });
      } catch {}
      throw new Error('SESSION_REFRESH_FAILED');
    }

    // Se durante o trânsito da requisição ocorreu logout ou a geração mudou, descarta
    // a renovação obsoleta para não ressuscitar indevidamente uma sessão encerrada.
    if (getSessionGeneration() !== startGen) {
      throw new Error('SESSION_TERMINATED_DURING_REFRESH');
    }

    const newGen = advanceSessionGeneration();
    inMemoryLastFailed = 0;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(AUTH_FAILED_KEY);
      }
    } catch {}
    try {
      broadcastChannel?.postMessage({
        type: 'REFRESH_SUCCESS',
        generation: newGen,
        timestamp: Date.now(),
      });
    } catch {}
  } finally {
    activeRefreshAbortController = null;
  }
}

async function refreshSession(requestGeneration?: number): Promise<void> {
  const targetGen = requestGeneration ?? getSessionGeneration();

  if (getSessionGeneration() > targetGen) {
    return;
  }

  if (refreshPromise) {
    await refreshPromise;
    return;
  }

  refreshPromise = (async () => {
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    const hasLocks = typeof nav?.locks?.request === 'function';

    if (!hasLocks) {
      if (getSessionGeneration() > targetGen) return;
      return performDirectRefresh();
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);

    try {
      await nav.locks.request(AUTH_LOCK_NAME, { signal: controller.signal }, async () => {
        clearTimeout(timeoutId);

        if (getSessionGeneration() > targetGen) {
          return;
        }

        let lastFailed = inMemoryLastFailed;
        try {
          if (typeof localStorage !== 'undefined') {
            const val = localStorage.getItem(AUTH_FAILED_KEY);
            if (val) lastFailed = Math.max(lastFailed, parseInt(val, 10) || 0);
          }
        } catch {}

        if (lastFailed > 0 && Math.abs(Date.now() - lastFailed) < 5_000) {
          throw new Error('SESSION_REFRESH_FAILED');
        }

        await performDirectRefresh();
      });
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      if (err && typeof err === 'object' && 'name' in err && err.name === 'AbortError') {
        // F-01: Lock ocupado além do limite. NUNCA executa performDirectRefresh fora do lock!
        // Não provoca logout automático: se a geração avançou, retorna; se não, retorna para o caller
        // retestar a requisição e determinar a validade real da sessão.
        if (getSessionGeneration() > targetGen) return;
        return;
      }
      throw err;
    }
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

export function setSessionExpiredHandler(handler: (() => void) | undefined) { sessionExpiredHandler = handler; }

export class ApiRequestError extends Error {
  status: number;
  code?: string;
  details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function apiRequest<T>(path: string, options: RequestInit = {}) {
  const method = (options.method ?? 'GET').toUpperCase();
  const requestGen = getSessionGeneration();
  let response = await fetchApi(path, options);
  const refreshable = response.status === 401 && safeMethods.has(method) && path !== '/auth/refresh' && path !== '/auth/login';
  if (refreshable) {
    try {
      await refreshSession(requestGen);
      response = await fetchApi(path, options);
    } catch {
      sessionExpiredHandler?.();
      notifySessionLogout();
      throw new ApiRequestError('Sua sessão expirou. Entre novamente.', 401, 'UNAUTHENTICATED');
    }
  }
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      sessionExpiredHandler?.();
      notifySessionLogout();
    }
    let message = body.error?.message;
    if (!message && Array.isArray(body.error?.details) && body.error.details.length > 0) {
      const first = body.error.details[0];
      const field = Array.isArray(first?.path) ? first.path.join('.') : '';
      message = field
        ? `Campo obrigatório ou inválido (${field}): ${first.message || 'verifique o valor informado.'}`
        : (first.message || 'Dados inválidos.');
    }
    throw new ApiRequestError(
      message || 'Não foi possível concluir a operação.',
      response.status,
      body.error?.code,
      body.error?.details
    );
  }
  return body.data as T;
}

export async function downloadFile(path: string, fallbackFilename = 'anexo'): Promise<void> {
  const requestGen = getSessionGeneration();
  let response = await fetchApi(path, { method: 'GET' });
  if (response.status === 401) {
    try {
      await refreshSession(requestGen);
      response = await fetchApi(path, { method: 'GET' });
    } catch {
      sessionExpiredHandler?.();
      notifySessionLogout();
      throw new Error('Sua sessão expirou. Entre novamente.');
    }
  }

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.error?.message ?? 'Não foi possível baixar o arquivo.');
  }

  let filename = fallbackFilename;
  const disposition = response.headers.get('content-disposition');
  if (disposition) {
    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match && utf8Match[1]) {
      try {
        filename = decodeURIComponent(utf8Match[1]);
      } catch {
        // Fallback
      }
    } else {
      const standardMatch = disposition.match(/filename="?([^";]+)"?/i);
      if (standardMatch && standardMatch[1]) {
        filename = standardMatch[1];
      }
    }
  }

  const blob = await response.blob();
  const blobUrl = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(blobUrl);
}

