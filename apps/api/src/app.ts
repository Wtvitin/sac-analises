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

export const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173' }));
app.use(express.json({ limit: '1mb' }));
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
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof ZodError) return res.status(422).json({ error: { code: 'VALIDATION_ERROR', details: error.issues } });
  console.error(error);
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Não foi possível concluir a operação.' } });
});
