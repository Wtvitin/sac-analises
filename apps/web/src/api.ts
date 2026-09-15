export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3333';
export type AuthUser = { id: string; name: string; email: string; role: 'ADMIN' | 'ANALYST' | 'VIEWER'; active: boolean; approvedAt: string | null; timezone: string; lastLoginAt: string | null };

export async function apiRequest<T>(path: string, options: RequestInit = {}) {
  const token = localStorage.getItem('sac_token') ?? sessionStorage.getItem('sac_token');
  const response = await fetch(`${API_URL}${path}`, { ...options, headers: { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message ?? 'Não foi possível concluir a operação.');
  return body.data as T;
}
