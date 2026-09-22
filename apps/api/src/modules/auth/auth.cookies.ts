import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { getSecurityConfig } from '../../config.js';

export const ACCESS_COOKIE = 'sac_access';
export const REFRESH_COOKIE = 'sac_refresh';
export const CSRF_COOKIE = 'sac_csrf';

type CookieOptions = { httpOnly: boolean; path: string; maxAgeSeconds: number };

function serializeCookie(name: string, value: string, options: CookieOptions) {
  const { production } = getSecurityConfig();
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAgeSeconds}`,
    'SameSite=Lax',
    options.httpOnly ? 'HttpOnly' : '',
    production ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

export function readCookie(req: Request, name: string) {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return undefined; }
  }
  return undefined;
}

export function appendCookie(res: Response, name: string, value: string, options: CookieOptions) {
  res.append('Set-Cookie', serializeCookie(name, value, options));
}

export function clearCookie(res: Response, name: string, options: Omit<CookieOptions, 'maxAgeSeconds'>) {
  appendCookie(res, name, '', { ...options, maxAgeSeconds: 0 });
}

export function issueCsrfCookie(req: Request, res: Response) {
  const current = readCookie(req, CSRF_COOKIE);
  if (current && current.length >= 32) return current;
  const token = randomBytes(32).toString('base64url');
  const { refreshTokenDays } = getSecurityConfig();
  appendCookie(res, CSRF_COOKIE, token, { httpOnly: false, path: '/', maxAgeSeconds: refreshTokenDays * 86_400 });
  return token;
}

export function csrfMatches(req: Request) {
  const cookie = readCookie(req, CSRF_COOKIE);
  const header = req.get('x-csrf-token');
  if (!cookie || !header) return false;
  const left = Buffer.from(cookie); const right = Buffer.from(header);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function setAuthenticationCookies(res: Response, accessToken: string, refreshToken: string) {
  const config = getSecurityConfig();
  appendCookie(res, ACCESS_COOKIE, accessToken, { httpOnly: true, path: '/', maxAgeSeconds: config.accessTokenMinutes * 60 });
  appendCookie(res, REFRESH_COOKIE, refreshToken, { httpOnly: true, path: '/auth', maxAgeSeconds: config.refreshTokenDays * 86_400 });
}

export function clearAuthenticationCookies(res: Response) {
  clearCookie(res, ACCESS_COOKIE, { httpOnly: true, path: '/' });
  clearCookie(res, REFRESH_COOKIE, { httpOnly: true, path: '/auth' });
}
