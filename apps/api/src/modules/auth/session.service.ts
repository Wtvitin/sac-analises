import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Prisma } from '@prisma/client';
import { getSecurityConfig } from '../../config.js';
import { prisma } from '../../lib/prisma.js';
import { AuthError } from './auth.service.js';

const sessionUserSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  department: true,
  active: true,
  approvedAt: true,
  rejectedAt: true,
  deletedAt: true,
  tokenVersion: true,
  timezone: true,
  lastLoginAt: true,
  mustChangePassword: true,
} as const;

function newRefreshToken() { return randomBytes(48).toString('base64url'); }
function refreshHash(token: string) { return createHmac('sha256', process.env.JWT_SECRET ?? '').update(token).digest('hex'); }
function expiryDate() { const date = new Date(); date.setUTCDate(date.getUTCDate() + getSecurityConfig().refreshTokenDays); return date; }
function publicUser(user: { id: string; name: string; email: string; role: 'ADMIN' | 'ANALYST' | 'VIEWER'; department?: string | null; active: boolean; approvedAt: Date | null; timezone: string; lastLoginAt: Date | null; mustChangePassword?: boolean }) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    department: user.department ?? null,
    active: user.active,
    approvedAt: user.approvedAt,
    timezone: user.timezone,
    lastLoginAt: user.lastLoginAt,
    mustChangePassword: Boolean(user.mustChangePassword),
  };
}
function accessToken(userId: string, tokenVersion: number, sessionId: string) {
  return jwt.sign({ version: tokenVersion, sessionId }, process.env.JWT_SECRET!, { subject: userId, expiresIn: `${getSecurityConfig().accessTokenMinutes}m` });
}

export async function createSession(user: Parameters<typeof publicUser>[0] & { tokenVersion: number }) {
  const refreshToken = newRefreshToken(); const familyId = randomUUID(); const expiresAt = expiryDate();
  const session = await prisma.$transaction(async tx => {
    const created = await tx.authSession.create({ data: { userId: user.id, familyId, refreshTokenHash: refreshHash(refreshToken), tokenVersion: user.tokenVersion, expiresAt }, select: { id: true } });
    await tx.adminAudit.create({ data: { type: 'LOGIN_SUCCEEDED', actorId: user.id, targetUserId: user.id, metadata: { sessionCreated: true } } });
    return created;
  });
  return { accessToken: accessToken(user.id, user.tokenVersion, session.id), refreshToken, user: publicUser(user) };
}

type RefreshResult = { ok: true; accessToken: string; refreshToken: string; user: ReturnType<typeof publicUser> } | { ok: false };
export async function rotateSession(refreshToken: string | undefined): Promise<RefreshResult> {
  if (!refreshToken || refreshToken.length > 256) return { ok: false };
  const hash = refreshHash(refreshToken); const nextToken = newRefreshToken(); const now = new Date();
  return prisma.$transaction(async tx => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "AuthSession" WHERE "refreshTokenHash" = ${hash} FOR UPDATE`);
    const current = await tx.authSession.findUnique({ where: { refreshTokenHash: hash }, include: { user: { select: sessionUserSelect } } });
    if (!current) return { ok: false };
    if (current.rotatedAt) {
      await tx.authSession.updateMany({ where: { familyId: current.familyId, revokedAt: null }, data: { revokedAt: now } });
      await tx.adminAudit.create({ data: { type: 'SESSION_REUSE_DETECTED', targetUserId: current.userId, metadata: { familyRevoked: true } } });
      return { ok: false };
    }
    if (current.revokedAt || current.expiresAt <= now) {
      await tx.authSession.updateMany({ where: { familyId: current.familyId, revokedAt: null }, data: { revokedAt: now } });
      return { ok: false };
    }
    if (!current.user.active || !current.user.approvedAt || current.user.rejectedAt || current.user.deletedAt || current.tokenVersion !== current.user.tokenVersion) {
      await tx.authSession.updateMany({ where: { userId: current.userId, revokedAt: null }, data: { revokedAt: now } });
      return { ok: false };
    }
    const replacement = await tx.authSession.create({ data: { userId: current.userId, familyId: current.familyId, refreshTokenHash: refreshHash(nextToken), tokenVersion: current.tokenVersion, expiresAt: current.expiresAt }, select: { id: true } });
    await tx.authSession.update({ where: { id: current.id }, data: { revokedAt: now, rotatedAt: now, replacedById: replacement.id, lastUsedAt: now } });
    return { ok: true, accessToken: accessToken(current.userId, current.tokenVersion, replacement.id), refreshToken: nextToken, user: publicUser(current.user) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function currentSession(sessionId: string, userId: string) {
  const now = new Date();
  return prisma.authSession.findFirst({ where: { id: sessionId, userId, revokedAt: null, expiresAt: { gt: now } }, include: { user: { select: sessionUserSelect } } });
}

export async function revokeRefreshSession(refreshToken: string | undefined) {
  if (!refreshToken || refreshToken.length > 256) return;
  const hash = refreshHash(refreshToken);
  await prisma.$transaction(async tx => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "AuthSession" WHERE "refreshTokenHash" = ${hash} FOR UPDATE`);
    const session = await tx.authSession.findUnique({ where: { refreshTokenHash: hash }, select: { familyId: true } });
    if (session) await tx.authSession.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function revokeAllSessions(userId: string, audit = true) {
  const now = new Date();
  await prisma.$transaction(async tx => {
    await tx.authSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
    if (audit) await tx.adminAudit.create({ data: { type: 'ALL_SESSIONS_REVOKED', actorId: userId, targetUserId: userId, metadata: { selfService: true } } });
  });
}

export async function revokeOtherSessions(userId: string, currentSessionId: string) {
  const now = new Date();
  return prisma.$transaction(async tx => {
    const revoked = await tx.authSession.updateMany({ where: { userId, id: { not: currentSessionId }, revokedAt: null }, data: { revokedAt: now } });
    await tx.adminAudit.create({ data: { type: 'ALL_SESSIONS_REVOKED', actorId: userId, targetUserId: userId, metadata: { currentSessionPreserved: true, sessionsRevoked: revoked.count } } });
    return revoked.count;
  });
}

export function invalidSessionError() { return new AuthError('INVALID_SESSION', 'Sua sessão expirou. Entre novamente.', 401); }
