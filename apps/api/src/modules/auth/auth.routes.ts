import { Router, type NextFunction, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { normalizeEmail } from './auth.schema.js';
import { ACCESS_REQUEST_MESSAGE, AuthError, authenticate, changeOwnPassword, getOwnProfile, requestAccess, updateOwnProfile } from './auth.service.js';
import { requireAuth } from './auth.middleware.js';

export const authRouter = Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 8, standardHeaders: true, legacyHeaders: false });
const registrationIpLimiter = rateLimit({ windowMs: 30 * 60_000, limit: 5, standardHeaders: true, legacyHeaders: false });
const passwordLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 6, standardHeaders: true, legacyHeaders: false });
const emailAttempts = new Map<string, { count: number; resetAt: number }>();
const registrationEnabled = () => process.env.REGISTRATION_ENABLED === 'true';

export function consumeRegistrationEmailAttempt(emailValue: unknown, now = Date.now()) {
  if (emailAttempts.size > 5_000) { for (const [key, value] of emailAttempts) if (value.resetAt <= now) emailAttempts.delete(key); }
  if (typeof emailValue !== 'string') return true;
  const email = normalizeEmail(emailValue).slice(0, 254); if (!email) return true;
  if (emailAttempts.size >= 5_000 && !emailAttempts.has(email)) return false;
  const current = emailAttempts.get(email);
  if (!current || current.resetAt <= now) { emailAttempts.set(email, { count: 1, resetAt: now + 30 * 60_000 }); return true; }
  if (current.count >= 3) return false;
  current.count += 1; return true;
}

function registrationEmailLimiter(req: Request, res: Response, next: NextFunction) {
  if (consumeRegistrationEmailAttempt(req.body?.email)) return next();
  return res.status(429).json({ error: { code: 'TOO_MANY_REQUESTS', message: 'Não foi possível processar a solicitação agora. Tente novamente mais tarde.' } });
}

authRouter.get('/registration-config', (_req, res) => res.json({ data: { enabled: registrationEnabled() } }));
authRouter.post('/login', loginLimiter, async (req, res, next) => { try { const result = await authenticate(req.body); const token = jwt.sign({ version: result.user.tokenVersion }, process.env.JWT_SECRET!, { subject: result.user.id, expiresIn: '8h' }); res.json({ data: { token, user: result.publicUser } }); } catch (error) { next(error); } });
authRouter.post('/register', registrationIpLimiter, registrationEmailLimiter, async (req, res, next) => { try { if (!registrationEnabled()) return res.status(403).json({ error: { code: 'REGISTRATION_DISABLED', message: 'A solicitação pública de acesso está indisponível.' } }); await requestAccess(req.body); res.status(202).json({ data: { title: 'Solicitação enviada', message: ACCESS_REQUEST_MESSAGE } }); } catch (error) { next(error); } });
authRouter.get('/me', requireAuth, async (req, res) => res.json({ data: await getOwnProfile(req.auth!.userId) }));
authRouter.patch('/me', requireAuth, async (req, res) => res.json({ data: await updateOwnProfile(req.auth!.userId, req.body) }));
authRouter.post('/change-password', passwordLimiter, requireAuth, async (req, res, next) => { try { await changeOwnPassword(req.auth!.userId, req.body); res.status(204).send(); } catch (error) { next(error); } });
authRouter.use((error: unknown, _req: Request, res: Response, next: NextFunction) => error instanceof AuthError ? res.status(error.status).json({ error: { code: error.code, message: error.message } }) : next(error));
