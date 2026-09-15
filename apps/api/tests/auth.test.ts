import { describe, expect, it } from 'vitest';
import { registerSchema } from '../src/modules/auth/auth.schema.js';
import { hasRole } from '../src/modules/auth/auth.middleware.js';
import { hasPermission } from '../src/domain/permissions.js';
import { consumeRegistrationEmailAttempt } from '../src/modules/auth/auth.routes.js';

describe('autenticação e permissões', () => {
  it('rejeita senha fraca no cadastro', () => {
    expect(() => registerSchema.parse({ name: 'Pessoa Usuária', email: 'pessoa@empresa.com', password: 'senha-fraca', confirmPassword: 'senha-fraca' })).toThrow();
  });

  it('normaliza e-mail e aceita senha segura', () => {
    const result = registerSchema.parse({ name: 'Pessoa Usuária', email: 'PESSOA@EMPRESA.COM', password: 'SenhaSegura123', confirmPassword: 'SenhaSegura123' });
    expect(result.email).toBe('pessoa@empresa.com');
  });

  it('impede perfil de consulta em ações de analista', () => {
    expect(hasRole('VIEWER', ['ADMIN', 'ANALYST'])).toBe(false);
    expect(hasRole('ANALYST', ['ADMIN', 'ANALYST'])).toBe(true);
    expect(hasPermission('VIEWER', 'cases:write')).toBe(false);
    expect(hasPermission('ADMIN', 'users:manage')).toBe(true);
  });

  it('limita solicitações repetidas pelo e-mail normalizado', () => {
    const email = `rate-${Date.now()}@example.test`;
    expect(consumeRegistrationEmailAttempt(email, 1000)).toBe(true);
    expect(consumeRegistrationEmailAttempt(email.toUpperCase(), 1001)).toBe(true);
    expect(consumeRegistrationEmailAttempt(email, 1002)).toBe(true);
    expect(consumeRegistrationEmailAttempt(email, 1003)).toBe(false);
  });
});
