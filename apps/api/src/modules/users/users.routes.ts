import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';

export const usersRouter = Router();
usersRouter.use(requireAuth);
usersRouter.get('/assignable', async (_req, res) => { const users = await prisma.user.findMany({ where: { active: true, approvedAt: { not: null }, role: { in: ['ADMIN', 'ANALYST'] } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }); res.json({ data: users }); });
usersRouter.get('/', requireRole('ADMIN'), async (_req, res) => { const users = await prisma.user.findMany({ select: { id: true, name: true, email: true, role: true, active: true, approvedAt: true, createdAt: true }, orderBy: { name: 'asc' } }); res.json({ data: users }); });
usersRouter.patch('/:id/access', requireRole('ADMIN'), async (req, res) => { const input = z.object({ role: z.enum(['ADMIN', 'ANALYST', 'VIEWER']).optional(), active: z.boolean().optional(), approved: z.boolean().optional() }).parse(req.body); const user = await prisma.user.update({ where: { id: String(req.params.id) }, data: { role: input.role, active: input.active, ...(input.approved !== undefined ? { approvedAt: input.approved ? new Date() : null } : {}) }, select: { id: true, name: true, email: true, role: true, active: true, approvedAt: true } }); res.json({ data: user }); });
