import { describe, expect, it, vi } from 'vitest';
import { requireCsrf } from './csrf.middleware.js';

function run(method: string, cookie?: string, header?: string) {
  const req = { method, headers: { cookie }, get: () => header } as never; const status = vi.fn().mockReturnThis(); const json = vi.fn(); const next = vi.fn();
  requireCsrf(req, { status, json } as never, next); return { status, json, next };
}

describe('proteção CSRF', () => {
  it('não interfere em métodos seguros', () => { expect(run('GET').next).toHaveBeenCalled(); });
  it('aceita mutação somente quando cookie e header coincidem', () => {
    expect(run('POST', 'sac_csrf=csrf-test-value-long-enough', 'csrf-test-value-long-enough').next).toHaveBeenCalled();
    const rejected = run('PATCH', 'sac_csrf=csrf-test-value-long-enough', 'different-value');
    expect(rejected.status).toHaveBeenCalledWith(403); expect(rejected.json).toHaveBeenCalledWith({ error: { code: 'CSRF_REJECTED', message: 'Não foi possível validar a solicitação.' } });
  });
});
