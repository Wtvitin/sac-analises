import { describe, expect, it } from 'vitest';
import { can } from './permissions';

describe('matriz de permissões da interface', () => {
  it('limita gestão e escrita aos perfis corretos', () => {
    expect(can('ADMIN', 'users:manage')).toBe(true);
    expect(can('ANALYST', 'cases:write')).toBe(true);
    expect(can('ANALYST', 'users:manage')).toBe(false);
    expect(can('VIEWER', 'cases:read')).toBe(true);
    expect(can('VIEWER', 'cases:write')).toBe(false);
  });
});
