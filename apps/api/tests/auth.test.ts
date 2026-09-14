import { describe, expect, it } from 'vitest';
import { registerSchema } from '../src/modules/auth/auth.schema.js';
import { hasRole } from '../src/modules/auth/auth.middleware.js';

describe('autenticação e permissões', () => {
  it('rejeita senha fraca no cadastro', () => {
    expect(() => registerSchema.parse({ name: 'Pessoa Usuária', email: 'pessoa@empresa.com', password: 'senha-fraca' })).toThrow();
  });

  it('normaliza e-mail e aceita senha segura', () => {
    const result = registerSchema.parse({ name: 'Pessoa Usuária', email: 'PESSOA@EMPRESA.COM', password: 'SenhaSegura123' });
    expect(result.email).toBe('pessoa@empresa.com');
  });

  it('impede perfil de consulta em ações de analista', () => {
    expect(hasRole('VIEWER', ['ADMIN', 'ANALYST'])).toBe(false);
    expect(hasRole('ANALYST', ['ADMIN', 'ANALYST'])).toBe(true);
  });
});
