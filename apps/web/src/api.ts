export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3333';
export type AuthUser = { id: string; name: string; email: string; role: 'ADMIN' | 'ANALYST' | 'VIEWER'; active: boolean; approvedAt: string | null; timezone: string; lastLoginAt: string | null };

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
let refreshPromise: Promise<void> | null = null;
let sessionExpiredHandler: (() => void) | undefined;

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

async function refreshSession() {
  if (!refreshPromise) {
    refreshPromise = fetchApi('/auth/refresh', { method: 'POST' }).then(async response => {
      if (!response.ok) throw new Error('SESSION_REFRESH_FAILED');
    }).finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

export function setSessionExpiredHandler(handler: (() => void) | undefined) { sessionExpiredHandler = handler; }

export async function apiRequest<T>(path: string, options: RequestInit = {}) {
  const method = (options.method ?? 'GET').toUpperCase();
  let response = await fetchApi(path, options);
  const refreshable = response.status === 401 && safeMethods.has(method) && path !== '/auth/refresh' && path !== '/auth/login';
  if (refreshable) {
    try { await refreshSession(); response = await fetchApi(path, options); }
    catch { sessionExpiredHandler?.(); throw new Error('Sua sessão expirou. Entre novamente.'); }
  }
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) sessionExpiredHandler?.();
    throw new Error(body.error?.message ?? 'Não foi possível concluir a operação.');
  }
  return body.data as T;
}
