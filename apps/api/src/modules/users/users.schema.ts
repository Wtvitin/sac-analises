import { z } from 'zod';

const justification = z.string().trim().min(5).max(500);
export const userIdSchema = z.string().trim().min(1).max(80);
export const listUsersSchema = z.object({
  query: z.string().trim().max(120).default(''), role: z.enum(['all', 'ADMIN', 'ANALYST', 'VIEWER']).default('all'),
  state: z.enum(['all', 'active', 'inactive']).default('all'), approval: z.enum(['all', 'pending', 'approved', 'rejected']).default('all'),
  sort: z.enum(['name', 'email', 'role', 'createdAt', 'lastLoginAt']).default('name'), order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().positive().default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
export const DEFAULT_USER_DEPARTMENTS = [
  'Estoque',
  'Controle de Qualidade',
  'Qualidade',
  'Recebimento',
  'Almoxarifado',
  'Compras',
] as const;

export const approveUserSchema = z.object({
  role: z.enum(['ANALYST', 'VIEWER']),
  department: z.string().trim().max(100).optional().nullable(),
});
export const rejectUserSchema = z.object({ justification });
export const changeRoleSchema = z.object({ role: z.enum(['ANALYST', 'VIEWER']), justification: z.string().trim().max(500).optional() });
export const updateUserDepartmentSchema = z.object({
  department: z.string().trim().max(100).optional().nullable(),
  justification: z.string().trim().max(500).optional(),
});
export const deactivateUserSchema = z.object({ justification: z.string().trim().max(500).optional(), strategy: z.enum(['transfer', 'unassigned']).optional(), transferToUserId: z.string().trim().min(1).max(80).optional(), confirmUnassigned: z.boolean().optional() });
export const deleteUserSchema = z.object({
  justification: z.string().trim().max(500).optional(),
  strategy: z.enum(['transfer', 'unassigned']).optional(),
  transferToUserId: z.string().trim().max(80).optional(),
  confirmUnassigned: z.boolean().optional(),
});
export const reactivateUserSchema = z.object({ justification });
export const createUserSchema = z.object({
  name: z.string().trim().min(3, 'O nome deve ter pelo menos 3 caracteres.').max(120),
  email: z.string().trim().email('E-mail inválido.').max(254),
  role: z.enum(['ANALYST', 'VIEWER']),
  department: z.string().trim().max(100).optional().nullable(),
});


