import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { isProvisionalPasswordExpired } from '../../lib/auth/provisional-password.js';
import { sendPasswordResetEmail } from '../../lib/email/email.service.js';
import { changePasswordSchema, forgotPasswordSchema, loginSchema, profileNameSchema, registerSchema, resetPasswordSchema } from './auth.schema.js';

export const ACCESS_REQUEST_MESSAGE = 'Sua conta precisa ser aprovada por um administrador antes do primeiro acesso.';
export class AuthError extends Error { constructor(public code: string, message: string, public status: number) { super(message); } }

const publicUserSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  active: true,
  approvedAt: true,
  timezone: true,
  lastLoginAt: true,
  mustChangePassword: true,
} as const;

export async function requestAccess(raw: unknown) {
  const input = registerSchema.parse(raw);
  const passwordHash = await bcrypt.hash(input.password, 12);
  try {
    return await prisma.$transaction(async tx => {
      if (await tx.user.findUnique({ where: { email: input.email }, select: { id: true } })) return { accepted: true, created: false };
      const user = await tx.user.create({
        data: {
          name: input.name,
          email: input.email,
          passwordHash,
          role: 'VIEWER',
          active: false,
          mustChangePassword: true,
        },
        select: { id: true },
      });
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
  if (!user || !user.active || !user.approvedAt || user.rejectedAt) {
    throw new AuthError('INVALID_CREDENTIALS', 'E-mail ou senha inválidos, ou cadastro aguardando aprovação.', 401);
  }

  if (user.mustChangePassword && isProvisionalPasswordExpired(user.provisionalPasswordExpiresAt)) {
    throw new AuthError('PROVISIONAL_PASSWORD_EXPIRED', 'A senha provisória expirou. Solicite o reenvio ao administrador.', 401);
  }

  if (!(await bcrypt.compare(input.password, user.passwordHash))) {
    throw new AuthError('INVALID_CREDENTIALS', 'E-mail ou senha inválidos, ou cadastro aguardando aprovação.', 401);
  }

  const lastLoginAt = new Date();
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt } });
  return {
    user: { ...user, lastLoginAt },
    publicUser: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      active: user.active,
      approvedAt: user.approvedAt,
      timezone: user.timezone,
      lastLoginAt,
      mustChangePassword: Boolean(user.mustChangePassword),
    },
  };
}

export async function getOwnProfile(userId: string) { return prisma.user.findUniqueOrThrow({ where: { id: userId }, select: publicUserSelect }); }
export async function updateOwnProfile(userId: string, raw: unknown) { const input = profileNameSchema.parse(raw); return prisma.user.update({ where: { id: userId }, data: { name: input.name }, select: publicUserSelect }); }

export async function changeOwnPassword(userId: string, raw: unknown) {
  const input = changePasswordSchema.parse(raw);
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { passwordHash: true, mustChangePassword: true },
  });
  if (!(await bcrypt.compare(input.currentPassword, user.passwordHash))) {
    throw new AuthError('INVALID_CURRENT_PASSWORD', 'A senha atual não confere.', 422);
  }
  if (await bcrypt.compare(input.newPassword, user.passwordHash)) {
    throw new AuthError('PASSWORD_UNCHANGED', 'A nova senha deve ser diferente da atual.', 422);
  }
  const passwordHash = await bcrypt.hash(input.newPassword, 12);
  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        mustChangePassword: false,
        provisionalPasswordHash: null,
        provisionalPasswordCreatedAt: null,
        provisionalPasswordExpiresAt: null,
        tokenVersion: { increment: 1 },
      },
      select: { id: true },
    }),
    prisma.authSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    prisma.adminAudit.create({
      data: {
        type: 'PASSWORD_CHANGED',
        actorId: userId,
        targetUserId: userId,
        metadata: { selfService: true, firstAccess: Boolean(user.mustChangePassword) },
      },
    }),
  ]);
}

export const GENERIC_RESET_RESPONSE = {
  message: 'Se o e-mail estiver cadastrado e ativo, enviamos as instruções para redefinição de senha.',
};

export async function requestPasswordReset(raw: unknown) {
  const input = forgotPasswordSchema.parse(raw);
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: {
      id: true,
      name: true,
      email: true,
      active: true,
      approvedAt: true,
      rejectedAt: true,
    },
  });

  // Resposta estritamente genérica para evitar enumeração de contas
  if (!user || !user.active || !user.approvedAt || user.rejectedAt) {
    return GENERIC_RESET_RESPONSE;
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutos

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: expiresAt,
    },
  });

  try {
    await sendPasswordResetEmail({
      to: user.email,
      name: user.name,
      resetToken: rawToken,
      expiresAt,
    });

    await prisma.adminAudit.create({
      data: {
        type: 'PASSWORD_RESET_REQUESTED',
        actorId: user.id,
        targetUserId: user.id,
        metadata: {
          expiresAt: expiresAt.toISOString(),
          emailDelivered: true,
        },
      },
    });
  } catch (err: unknown) {
    console.error('Falha ao enviar e-mail de recuperação de senha:', err);
    // Não revelar erro interno do SMTP na resposta pública
  }

  return GENERIC_RESET_RESPONSE;
}

export async function resetPasswordWithToken(raw: unknown) {
  const input = resetPasswordSchema.parse(raw);
  const tokenHash = crypto.createHash('sha256').update(input.token).digest('hex');
  const now = new Date();

  const user = await prisma.user.findFirst({
    where: {
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: { gt: now },
      active: true,
      approvedAt: { not: null },
      rejectedAt: null,
    },
    select: {
      id: true,
      email: true,
      passwordHash: true,
      mustChangePassword: true,
    },
  });

  if (!user) {
    throw new AuthError('INVALID_RESET_TOKEN', 'Link de redefinição inválido ou expirado.', 400);
  }

  if (await bcrypt.compare(input.newPassword, user.passwordHash)) {
    throw new AuthError('PASSWORD_UNCHANGED', 'A nova senha deve ser diferente da anterior.', 422);
  }

  const newPasswordHash = await bcrypt.hash(input.newPassword, 12);

  await prisma.$transaction(async tx => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash: newPasswordHash,
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
        mustChangePassword: false,
        provisionalPasswordHash: null,
        provisionalPasswordCreatedAt: null,
        provisionalPasswordExpiresAt: null,
        tokenVersion: { increment: 1 },
      },
    });

    // Revoga todas as sessões ativas do usuário
    await tx.authSession.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: now },
    });

    await tx.adminAudit.create({
      data: {
        type: 'PASSWORD_CHANGED',
        actorId: user.id,
        targetUserId: user.id,
        metadata: { method: 'password_reset_token' },
      },
    });
  });

  return { success: true, message: 'Senha redefinida com sucesso. Faça login com sua nova senha.' };
}

