import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { changePasswordSchema, loginSchema, profileNameSchema, registerSchema } from './auth.schema.js';

export const ACCESS_REQUEST_MESSAGE = 'Sua conta precisa ser aprovada por um administrador antes do primeiro acesso.';
export class AuthError extends Error { constructor(public code: string, message: string, public status: number) { super(message); } }

const publicUserSelect = { id: true, name: true, email: true, role: true, active: true, approvedAt: true, timezone: true, lastLoginAt: true } as const;

export async function requestAccess(raw: unknown) {
  const input = registerSchema.parse(raw);
  const passwordHash = await bcrypt.hash(input.password, 12);
  try {
    return await prisma.$transaction(async tx => {
      if (await tx.user.findUnique({ where: { email: input.email }, select: { id: true } })) return { accepted: true, created: false };
      const user = await tx.user.create({ data: { name: input.name, email: input.email, passwordHash, role: 'VIEWER', active: false }, select: { id: true } });
      await tx.adminAudit.create({ data: { type: 'ACCESS_REQUESTED', targetUserId: user.id, metadata: { source: 'public-request' } } });
      const administrators = await tx.user.findMany({ where: { role: 'ADMIN', active: true, approvedAt: { not: null }, rejectedAt: null }, select: { id: true } });
      if (administrators.length) await tx.notification.createMany({ data: administrators.map(admin => ({ recipientId: admin.id, type: 'ACCESS_REQUEST' as const, title: 'Solicitação de acesso pendente', summary: 'Existe uma nova solicitação aguardando análise.', metadata: { requestUserId: user.id }, dedupeKey: `access-request:${user.id}` })), skipDuplicates: true });
      return { accepted: true, created: true };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return { accepted: true, created: false };
    throw error;
  }
}

export async function authenticate(raw: unknown) {
  const input = loginSchema.parse(raw);
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user || !user.active || !user.approvedAt || user.rejectedAt || !(await bcrypt.compare(input.password, user.passwordHash))) throw new AuthError('INVALID_CREDENTIALS', 'E-mail ou senha inválidos, ou cadastro aguardando aprovação.', 401);
  const lastLoginAt = new Date();
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt } });
  return { user: { ...user, lastLoginAt }, publicUser: { id: user.id, name: user.name, email: user.email, role: user.role, active: user.active, approvedAt: user.approvedAt, timezone: user.timezone, lastLoginAt } };
}

export async function getOwnProfile(userId: string) { return prisma.user.findUniqueOrThrow({ where: { id: userId }, select: publicUserSelect }); }
export async function updateOwnProfile(userId: string, raw: unknown) { const input = profileNameSchema.parse(raw); return prisma.user.update({ where: { id: userId }, data: { name: input.name }, select: publicUserSelect }); }

export async function changeOwnPassword(userId: string, raw: unknown) {
  const input = changePasswordSchema.parse(raw);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true } });
  if (!(await bcrypt.compare(input.currentPassword, user.passwordHash))) throw new AuthError('INVALID_CURRENT_PASSWORD', 'A senha atual não confere.', 422);
  if (await bcrypt.compare(input.newPassword, user.passwordHash)) throw new AuthError('PASSWORD_UNCHANGED', 'A nova senha deve ser diferente da atual.', 422);
  const passwordHash = await bcrypt.hash(input.newPassword, 12);
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash, tokenVersion: { increment: 1 } }, select: { id: true } }),
    prisma.authSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    prisma.adminAudit.create({ data: { type: 'PASSWORD_CHANGED', actorId: userId, targetUserId: userId, metadata: { selfService: true } } }),
  ]);
}
