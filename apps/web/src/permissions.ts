import type { AuthUser } from './api';

export type UiPermission = 'cases:read' | 'cases:write' | 'catalogs:read' | 'catalogs:manage' | 'users:manage';
const matrix: Record<AuthUser['role'], readonly UiPermission[]> = {
  ADMIN: ['cases:read', 'cases:write', 'catalogs:read', 'catalogs:manage', 'users:manage'],
  ANALYST: ['cases:read', 'cases:write', 'catalogs:read'],
  VIEWER: ['cases:read', 'catalogs:read'],
};
export function can(role: AuthUser['role'], permission: UiPermission) { return matrix[role].includes(permission); }
