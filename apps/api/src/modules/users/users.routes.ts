import { Router, type NextFunction, type Request, type Response } from 'express';
import { requireAuth, requirePermission } from '../auth/auth.middleware.js';
import { approveUserSchema, changeRoleSchema, createUserSchema, deactivateUserSchema, deleteUserSchema, listUsersSchema, rejectUserSchema, userIdSchema } from './users.schema.js';
import { approveUser, changeUserRole, completeActivation, createUser, deactivateUser, deleteUser, listUserAudits, listUsers, reactivateUser, rejectUser, resendProvisionalPassword, teamSummary, UserManagementError } from './users.service.js';
import { prisma } from '../../lib/prisma.js';

export const usersRouter = Router();
usersRouter.use(requireAuth);
usersRouter.get('/assignable', async (_req, res) => { const users = await prisma.user.findMany({ where: { active: true, approvedAt: { not: null }, rejectedAt: null, deletedAt: null, role: { in: ['ADMIN', 'ANALYST'] } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }); res.json({ data: users }); });
usersRouter.use(requirePermission('users:manage'));
usersRouter.get('/summary', async (_req, res) => res.json({ data: await teamSummary() }));
usersRouter.get('/', async (req, res) => res.json({ data: await listUsers(listUsersSchema.parse(req.query)) }));
usersRouter.post('/', async (req, res) => { const input = createUserSchema.parse(req.body); res.status(201).json({ data: await createUser(input, req.auth!.userId) }); });
usersRouter.post('/:id/approve', async (req, res) => { const input = approveUserSchema.parse(req.body); res.json({ data: await approveUser(userIdSchema.parse(req.params.id), input.role, req.auth!.userId) }); });
usersRouter.post('/:id/complete-activation', async (req, res) => res.json({ data: await completeActivation(userIdSchema.parse(req.params.id), req.auth!.userId) }));
usersRouter.post('/:id/resend-provisional', async (req, res) => res.json({ data: await resendProvisionalPassword(userIdSchema.parse(req.params.id), req.auth!.userId) }));
usersRouter.post('/:id/reject', async (req, res) => { const input = rejectUserSchema.parse(req.body); res.json({ data: await rejectUser(userIdSchema.parse(req.params.id), input.justification, req.auth!.userId) }); });
usersRouter.patch('/:id/role', async (req, res) => res.json({ data: await changeUserRole(userIdSchema.parse(req.params.id), changeRoleSchema.parse(req.body), req.auth!.userId) }));
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
