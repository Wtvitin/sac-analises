import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { requireAuth, requirePermission } from '../auth/auth.middleware.js';
import { approveUserSchema, changeRoleSchema, createUserSchema, deactivateUserSchema, deleteUserSchema, listUsersSchema, rejectUserSchema, updateUserDepartmentSchema, userIdSchema } from './users.schema.js';
import { approveUser, changeUserRole, completeActivation, createUser, deactivateUser, deleteUser, listDepartments, listUserAudits, listUsers, reactivateUser, rejectUser, resendProvisionalPassword, teamSummary, updateUserDepartment, UserManagementError } from './users.service.js';
import { prisma } from '../../lib/prisma.js';

export const usersRouter = Router();

const resendProvisionalUserLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => (req.auth?.userId ? `user:${req.auth.userId}` : ipKeyGenerator(req.ip || '127.0.0.1')),
  handler: (_req: Request, res: Response) => res.status(429).json({
    error: { code: 'TOO_MANY_REQUESTS', message: 'Muitas tentativas de reenvio de senha por este administrador. Aguarde alguns minutos.' },
  }),
});

const resendProvisionalIpLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => res.status(429).json({
    error: { code: 'TOO_MANY_REQUESTS', message: 'Limite de tentativas de reenvio de senha por rede excedido. Aguarde alguns minutos.' },
  }),
});

usersRouter.use(requireAuth);
usersRouter.get('/departments', async (_req, res) => res.json({ data: await listDepartments() }));
usersRouter.get('/assignable', async (req, res) => {
  const role = req.auth?.role;
  const userDepartment = req.auth?.department;
  const requestedDepartment = typeof req.query.department === 'string' ? req.query.department.trim() : undefined;

  let targetDepartment: string | undefined;
  if (role !== 'ADMIN') {
    targetDepartment = userDepartment ?? undefined;
  } else if (requestedDepartment) {
    targetDepartment = requestedDepartment;
  }

  const where = {
    active: true,
    approvedAt: { not: null },
    rejectedAt: null,
    deletedAt: null,
    ...(targetDepartment
      ? {
          OR: [
            { role: 'ADMIN' as const },
            { role: 'ANALYST' as const, department: targetDepartment },
          ],
        }
      : {
          role: { in: ['ADMIN' as const, 'ANALYST' as const] },
        }),
  };

  const users = await prisma.user.findMany({
    where,
    select: { id: true, name: true, role: true, department: true },
    orderBy: { name: 'asc' },
  });
  res.json({ data: users });
});
usersRouter.use(requirePermission('users:manage'));
usersRouter.get('/summary', async (_req, res) => res.json({ data: await teamSummary() }));
usersRouter.get('/', async (req, res) => res.json({ data: await listUsers(listUsersSchema.parse(req.query)) }));
usersRouter.post('/', async (req, res) => { const input = createUserSchema.parse(req.body); res.status(201).json({ data: await createUser(input, req.auth!.userId) }); });
usersRouter.post('/:id/approve', async (req, res) => { const input = approveUserSchema.parse(req.body); res.json({ data: await approveUser(userIdSchema.parse(req.params.id), input.role, req.auth!.userId, input.department) }); });
usersRouter.post('/:id/complete-activation', async (req, res) => res.json({ data: await completeActivation(userIdSchema.parse(req.params.id), req.auth!.userId) }));
usersRouter.post('/:id/resend-provisional', resendProvisionalIpLimiter, resendProvisionalUserLimiter, async (req, res) => res.json({ data: await resendProvisionalPassword(userIdSchema.parse(req.params.id), req.auth!.userId) }));
usersRouter.post('/:id/reject', async (req, res) => { const input = rejectUserSchema.parse(req.body); res.json({ data: await rejectUser(userIdSchema.parse(req.params.id), input.justification, req.auth!.userId) }); });
usersRouter.patch('/:id/role', async (req, res) => res.json({ data: await changeUserRole(userIdSchema.parse(req.params.id), changeRoleSchema.parse(req.body), req.auth!.userId) }));
usersRouter.patch('/:id/department', async (req, res) => { const input = updateUserDepartmentSchema.parse(req.body); res.json({ data: await updateUserDepartment(userIdSchema.parse(req.params.id), input.department, req.auth!.userId) }); });
usersRouter.post('/:id/deactivate', async (req, res) => res.json({ data: await deactivateUser(userIdSchema.parse(req.params.id), deactivateUserSchema.parse(req.body ?? {}), req.auth!.userId) }));
usersRouter.post('/:id/reactivate', async (req, res) => res.json({ data: await reactivateUser(userIdSchema.parse(req.params.id), req.body?.justification ?? '', req.auth!.userId) }));
usersRouter.get('/:id/audits', async (req, res) => res.json({ data: await listUserAudits(userIdSchema.parse(req.params.id)) }));
usersRouter.delete('/:id', async (req, res) => {
  const input = deleteUserSchema.parse(req.body ?? {});
  res.json({ data: await deleteUser(userIdSchema.parse(req.params.id), input, req.auth!.userId) });
});
usersRouter.post('/:id/delete', async (req, res) => {
  const input = deleteUserSchema.parse(req.body ?? {});
  res.json({ data: await deleteUser(userIdSchema.parse(req.params.id), input, req.auth!.userId) });
});
usersRouter.use((error: unknown, _req: Request, res: Response, next: NextFunction) => error instanceof UserManagementError ? res.status(error.status).json({ error: { code: error.code, message: error.message } }) : next(error));
