import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { UserRole } from '@prisma/client';

type TokenPayload = { sub: string; role: UserRole };
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Faça login para continuar.' } });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET ?? '') as TokenPayload;
    req.auth = { userId: payload.sub, role: payload.role }; return next();
  } catch { return res.status(401).json({ error: { code: 'INVALID_SESSION', message: 'Sua sessão expirou. Entre novamente.' } }); }
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => hasRole(req.auth!.role, roles) ? next() : res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Você não tem permissão para esta ação.' } });
}

export function hasRole(role: UserRole, allowed: UserRole[]) { return allowed.includes(role); }
