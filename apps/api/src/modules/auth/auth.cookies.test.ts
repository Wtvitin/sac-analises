import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRF_COOKIE, clearAuthenticationCookies, csrfMatches, issueCsrfCookie, setAuthenticationCookies } from './auth.cookies.js';

function response() { const cookies: string[] = []; return { cookies, res: { append: vi.fn((_name: string, value: string) => { cookies.push(value); }) } }; }

describe('cookies seguros de autenticação', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  beforeEach(() => { process.env.JWT_SECRET = 'test-only-secret'; delete process.env.NODE_ENV; delete process.env.ACCESS_TOKEN_TTL_MINUTES; delete process.env.REFRESH_TOKEN_TTL_DAYS; });
  afterEach(() => { process.env.NODE_ENV = originalNodeEnv; });

  it('usa HttpOnly, SameSite, caminhos e expirações explícitas no desenvolvimento sem exigir HTTPS', () => {
    const target = response(); setAuthenticationCookies(target.res as never, 'access-test', 'refresh-test');
    expect(target.cookies).toHaveLength(2);
    expect(target.cookies[0]).toMatch(/sac_access=.*Path=\/; Max-Age=900; SameSite=Lax; HttpOnly/);
    expect(target.cookies[1]).toMatch(/sac_refresh=.*Path=\/auth; Max-Age=2592000; SameSite=Lax; HttpOnly/);
    expect(target.cookies.join(' ')).not.toMatch(/; Secure/);
  });

  it('adiciona Secure obrigatoriamente em produção e limpa com os mesmos caminhos', () => {
    process.env.NODE_ENV = 'production'; process.env.WEB_ORIGIN = 'https://app.example.test';
    const target = response(); setAuthenticationCookies(target.res as never, 'access-test', 'refresh-test'); clearAuthenticationCookies(target.res as never);
    expect(target.cookies.every(value => value.includes('Secure'))).toBe(true);
    expect(target.cookies.slice(2).every(value => value.includes('Max-Age=0'))).toBe(true);
    expect(target.cookies[2]).toContain('Path=/'); expect(target.cookies[3]).toContain('Path=/auth');
  });

  it('mantém CSRF independente e legível, validando cookie e header em tempo constante', () => {
    const target = response(); const token = issueCsrfCookie({ headers: {} } as never, target.res as never);
    expect(target.cookies[0]).toContain(`${CSRF_COOKIE}=`); expect(target.cookies[0]).not.toContain('HttpOnly');
    expect(csrfMatches({ headers: { cookie: `${CSRF_COOKIE}=${token}` }, get: () => token } as never)).toBe(true);
    expect(csrfMatches({ headers: { cookie: `${CSRF_COOKIE}=${token}` }, get: () => 'invalid' } as never)).toBe(false);
  });
});
