import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { ZodError } from 'zod';
import { sacRouter } from './modules/sac/sac.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { requireAuth } from './modules/auth/auth.middleware.js';
import { usersRouter } from './modules/users/users.routes.js';
import { catalogRouter } from './modules/catalog/catalog.routes.js';
import { checkDatabaseHealth } from './lib/database-health.js';
import { notificationRouter } from './modules/notifications/notification.routes.js';
import { getSecurityConfig } from './config.js';
import { requireCsrf } from './modules/auth/csrf.middleware.js';
import { analyticsRouter } from './modules/analytics/analytics.routes.js';
import { attachmentRouter } from './modules/attachments/attachment.routes.js';
import { documentImportRouter } from './modules/document-imports/document-import.routes.js';

export const app = express();
const security = getSecurityConfig();
app.disable('x-powered-by');
app.set('trust proxy', security.trustProxy);
app.use(helmet());
app.use(cors({ origin(origin, callback) { if (!origin || origin === security.webOrigin) return callback(null, true); return callback(new Error('Origin not allowed')); }, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.headers['content-length'] !== '0' && !req.is(['application/json', 'application/*+json', 'multipart/form-data', 'application/x-www-form-urlencoded'])) {
    return res.status(415).json({ error: { code: 'UNSUPPORTED_CONTENT_TYPE', message: 'Tipo de conteúdo não suportado.' } });
  }
  return next();
});
app.use(requireCsrf);
app.get('/health', async (_req, res) => {
  const health = await checkDatabaseHealth();
  const ready = health.connected && health.schemaReady;
  return res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'degraded',
    api: 'up',
    database: health.connected ? 'connected' : 'unavailable',
    schema: health.schemaReady ? 'ready' : health.connected ? 'pending' : 'unknown',
  });
});
app.use('/auth', authRouter);
app.use('/users', usersRouter);
app.use('/catalog', catalogRouter);
app.use('/sac-records', requireAuth, sacRouter);
app.use('/notifications', notificationRouter);
app.use('/analytics', analyticsRouter);
app.use('/attachments', attachmentRouter);
app.use('/document-imports', documentImportRouter);
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof ZodError) return res.status(422).json({ error: { code: 'VALIDATION_ERROR', details: error.issues } });
  if (error instanceof SyntaxError) return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Conteúdo JSON inválido.' } });
  if (typeof error === 'object' && error && 'type' in error && error.type === 'entity.too.large') return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Conteúdo excede o limite permitido.' } });
  if (error instanceof Error && error.message === 'Origin not allowed') return res.status(403).json({ error: { code: 'ORIGIN_REJECTED', message: 'Origem não autorizada.' } });
  const safeError = error instanceof Error ? { name: error.name } : { name: 'UnknownError' };
  console.error('Unhandled application error', safeError);
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Não foi possível concluir a operação.' } });
});
