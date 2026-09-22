import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { UserRole } from '@prisma/client';
import { hasPermission, type Permission } from '../../domain/permissions.js';
import { ACCESS_COOKIE, readCookie } from './auth.cookies.js';
import { currentSession } from './session.service.js';

type TokenPayload = { sub: string; version: number; sessionId: string };
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = readCookie(req, ACCESS_COOKIE);
  if (!token) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Faça login para continuar.' } });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET ?? '') as TokenPayload;
    if (!payload.sub || !payload.sessionId || !Number.isInteger(payload.version)) throw new Error('invalid payload');
    const session = await currentSession(payload.sessionId, payload.sub); const user = session?.user;
    if (!user || !user.active || !user.approvedAt || user.rejectedAt || user.tokenVersion !== payload.version) throw new Error('invalid account state');
    if (session!.tokenVersion !== payload.version) throw new Error('invalid session version');
    req.auth = { userId: user.id, role: user.role, sessionId: session!.id }; return next();
  } catch { return res.status(401).json({ error: { code: 'INVALID_SESSION', message: 'Sua sessão expirou. Entre novamente.' } }); }
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => hasRole(req.auth!.role, roles) ? next() : res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Você não tem permissão para esta ação.' } });
}

export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction) => hasPermission(req.auth!.role, permission) ? next() : res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Você não tem permissão para esta ação.' } });
}

export function hasRole(role: UserRole, allowed: UserRole[]) { return allowed.includes(role); }
