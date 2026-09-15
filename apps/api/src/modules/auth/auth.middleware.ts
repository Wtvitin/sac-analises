import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { UserRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { hasPermission, type Permission } from '../../domain/permissions.js';

type TokenPayload = { sub: string; version: number };
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Faça login para continuar.' } });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET ?? '') as TokenPayload;
    if (!payload.sub || !Number.isInteger(payload.version)) throw new Error('invalid payload');
    const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true, role: true, active: true, approvedAt: true, rejectedAt: true, tokenVersion: true } });
    if (!user || !user.active || !user.approvedAt || user.rejectedAt || user.tokenVersion !== payload.version) throw new Error('invalid account state');
    req.auth = { userId: user.id, role: user.role }; return next();
  } catch { return res.status(401).json({ error: { code: 'INVALID_SESSION', message: 'Sua sessão expirou. Entre novamente.' } }); }
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => hasRole(req.auth!.role, roles) ? next() : res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Você não tem permissão para esta ação.' } });
}

export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction) => hasPermission(req.auth!.role, permission) ? next() : res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Você não tem permissão para esta ação.' } });
}

export function hasRole(role: UserRole, allowed: UserRole[]) { return allowed.includes(role); }
