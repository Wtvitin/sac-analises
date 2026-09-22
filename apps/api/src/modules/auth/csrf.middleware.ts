import type { NextFunction, Request, Response } from 'express';
import { csrfMatches } from './auth.cookies.js';

const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function requireCsrf(req: Request, res: Response, next: NextFunction) {
  if (!unsafeMethods.has(req.method) || csrfMatches(req)) return next();
  return res.status(403).json({ error: { code: 'CSRF_REJECTED', message: 'Não foi possível validar a solicitação.' } });
}
