import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { normalizeEmail } from './auth.schema.js';
import { ACCESS_REQUEST_MESSAGE, AuthError, authenticate, changeOwnPassword, getOwnProfile, requestAccess, requestPasswordReset, resetPasswordWithToken, updateOwnProfile } from './auth.service.js';
import { requireAuth } from './auth.middleware.js';
import { ACCESS_COOKIE, REFRESH_COOKIE, clearAuthenticationCookies, issueCsrfCookie, readCookie, setAuthenticationCookies } from './auth.cookies.js';
import { createSession, revokeAllSessions, revokeOtherSessions, revokeRefreshSession, rotateSession } from './session.service.js';

export const authRouter = Router();
const rateLimitHandler = (scope: string) => (_req: Request, res: Response) => { console.warn('Rate limit blocked request', { scope }); return res.status(429).json({ error: { code: 'TOO_MANY_REQUESTS', message: 'Muitas tentativas. Aguarde antes de tentar novamente.' } }); };
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 8, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler('login') });
const registrationIpLimiter = rateLimit({ windowMs: 30 * 60_000, limit: 5, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler('registration-ip') });
const passwordLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 6, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler('password-change') });
const refreshLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler('refresh') });
const forgotPasswordLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 5, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler('forgot-password') });
const resetPasswordLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 5, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler('reset-password') });
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

authRouter.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
authRouter.get('/registration-config', (req, res) => { issueCsrfCookie(req, res); res.json({ data: { enabled: registrationEnabled() } }); });
authRouter.get('/session', (req, res, next) => { issueCsrfCookie(req, res); return requireAuth(req, res, next); }, async (req, res) => res.json({ data: await getOwnProfile(req.auth!.userId) }));
authRouter.post('/login', loginLimiter, async (req, res, next) => { try { const result = await authenticate(req.body); const session = await createSession(result.user); setAuthenticationCookies(res, session.accessToken, session.refreshToken); issueCsrfCookie(req, res); res.json({ data: { user: session.user } }); } catch (error) { next(error); } });
authRouter.post('/refresh', refreshLimiter, async (req, res, next) => { try { const result = await rotateSession(readCookie(req, REFRESH_COOKIE)); if (!result.ok) { clearAuthenticationCookies(res); return res.status(401).json({ error: { code: 'INVALID_SESSION', message: 'Sua sessão expirou. Entre novamente.' } }); } setAuthenticationCookies(res, result.accessToken, result.refreshToken); return res.json({ data: { user: result.user } }); } catch (error) { next(error); } });
authRouter.post('/logout', async (req, res, next) => { try { await revokeRefreshSession(readCookie(req, REFRESH_COOKIE)); clearAuthenticationCookies(res); res.status(204).send(); } catch (error) { next(error); } });
authRouter.post('/logout-all', requireAuth, async (req, res, next) => { try { await revokeAllSessions(req.auth!.userId); clearAuthenticationCookies(res); res.status(204).send(); } catch (error) { next(error); } });
authRouter.post('/logout-others', requireAuth, async (req, res, next) => { try { const count = await revokeOtherSessions(req.auth!.userId, req.auth!.sessionId); res.json({ data: { count } }); } catch (error) { next(error); } });
authRouter.post('/register', registrationIpLimiter, registrationEmailLimiter, async (req, res, next) => { try { if (!registrationEnabled()) return res.status(403).json({ error: { code: 'REGISTRATION_DISABLED', message: 'A solicitação pública de acesso está indisponível.' } }); await requestAccess(req.body); res.status(202).json({ data: { title: 'Solicitação enviada', message: ACCESS_REQUEST_MESSAGE } }); } catch (error) { next(error); } });
authRouter.get('/me', requireAuth, async (req, res) => res.json({ data: await getOwnProfile(req.auth!.userId) }));
authRouter.patch('/me', requireAuth, async (req, res) => res.json({ data: await updateOwnProfile(req.auth!.userId, req.body) }));
authRouter.post('/change-password', passwordLimiter, requireAuth, async (req, res, next) => { try { await changeOwnPassword(req.auth!.userId, req.body); clearAuthenticationCookies(res); res.status(204).send(); } catch (error) { next(error); } });
authRouter.post('/forgot-password', forgotPasswordLimiter, async (req, res, next) => { try { const result = await requestPasswordReset(req.body); res.json({ data: result }); } catch (error) { next(error); } });
authRouter.post('/reset-password', resetPasswordLimiter, async (req, res, next) => { try { const result = await resetPasswordWithToken(req.body); clearAuthenticationCookies(res); res.json({ data: result }); } catch (error) { next(error); } });
authRouter.use((error: unknown, _req: Request, res: Response, next: NextFunction) => error instanceof AuthError ? res.status(error.status).json({ error: { code: error.code, message: error.message } }) : next(error));
