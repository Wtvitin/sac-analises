import type { UserRole } from '@prisma/client';

export type Permission = 'cases:read' | 'cases:write' | 'catalogs:read' | 'catalogs:manage' | 'users:manage';

export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  ADMIN: ['cases:read', 'cases:write', 'catalogs:read', 'catalogs:manage', 'users:manage'],
  ANALYST: ['cases:read', 'cases:write', 'catalogs:read'],
  VIEWER: ['cases:read', 'catalogs:read'],
};

export function hasPermission(role: UserRole, permission: Permission) { return ROLE_PERMISSIONS[role].includes(permission); }
