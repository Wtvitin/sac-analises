import { z } from 'zod';

const justification = z.string().trim().min(5).max(500);
export const userIdSchema = z.string().trim().min(1).max(80);
export const listUsersSchema = z.object({
  query: z.string().trim().max(120).default(''), role: z.enum(['all', 'ADMIN', 'ANALYST', 'VIEWER']).default('all'),
  state: z.enum(['all', 'active', 'inactive']).default('all'), approval: z.enum(['all', 'pending', 'approved', 'rejected']).default('all'),
  sort: z.enum(['name', 'email', 'role', 'createdAt', 'lastLoginAt']).default('name'), order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().positive().default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
export const approveUserSchema = z.object({ role: z.enum(['ANALYST', 'VIEWER']) });
export const rejectUserSchema = z.object({ justification });
export const changeRoleSchema = z.object({ role: z.enum(['ADMIN', 'ANALYST', 'VIEWER']), justification: z.string().trim().max(500).optional() });
export const deactivateUserSchema = z.object({ justification, strategy: z.enum(['transfer', 'unassigned']).optional(), transferToUserId: z.string().trim().min(1).max(80).optional(), confirmUnassigned: z.boolean().optional() });
export const reactivateUserSchema = z.object({ justification });
