import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { loginSchema, registerSchema } from './auth.schema.js';
import { requireAuth } from './auth.middleware.js';

export const authRouter = Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 8, standardHeaders: true, legacyHeaders: false });

authRouter.post('/login', loginLimiter, async (req, res) => {
  const input = loginSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user || !user.active || !user.approvedAt || !(await bcrypt.compare(input.password, user.passwordHash))) return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'E-mail ou senha inválidos, ou cadastro aguardando aprovação.' } });
  const token = jwt.sign({ role: user.role }, process.env.JWT_SECRET!, { subject: user.id, expiresIn: '8h' });
  return res.json({ data: { token, user: { id: user.id, name: user.name, email: user.email, role: user.role } } });
});

authRouter.post('/register', async (req, res) => {
  if (process.env.REGISTRATION_ENABLED !== 'true') return res.status(403).json({ error: { code: 'REGISTRATION_DISABLED', message: 'O cadastro público está desabilitado.' } });
  const input = registerSchema.parse(req.body);
  if (await prisma.user.findUnique({ where: { email: input.email } })) return res.status(409).json({ error: { code: 'EMAIL_IN_USE', message: 'Este e-mail já está cadastrado.' } });
  const requiresApproval = process.env.REGISTRATION_REQUIRES_APPROVAL !== 'false';
  await prisma.user.create({ data: { name: input.name, email: input.email, passwordHash: await bcrypt.hash(input.password, 12), role: 'VIEWER', approvedAt: requiresApproval ? null : new Date() } });
  return res.status(201).json({ data: { message: requiresApproval ? 'Cadastro enviado para aprovação.' : 'Conta criada com sucesso.' } });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId }, select: { id: true, name: true, email: true, role: true, timezone: true } });
  res.json({ data: user });
});

authRouter.patch('/me', requireAuth, async (req, res) => {
  const input = registerSchema.pick({ name: true }).parse(req.body);
  const user = await prisma.user.update({ where: { id: req.auth!.userId }, data: { name: input.name }, select: { id: true, name: true, email: true, role: true, timezone: true } });
  res.json({ data: user });
});

authRouter.post('/change-password', requireAuth, async (req, res) => {
  const input = z.object({ currentPassword: z.string().min(8), password: z.string().min(10).regex(/[A-Z]/).regex(/[a-z]/).regex(/[0-9]/) }).parse(req.body);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
  if (!(await bcrypt.compare(input.currentPassword, user.passwordHash))) return res.status(422).json({ error: { code: 'INVALID_CURRENT_PASSWORD', message: 'A senha atual não confere.' } });
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(input.password, 12) } });
  return res.status(204).send();
});
