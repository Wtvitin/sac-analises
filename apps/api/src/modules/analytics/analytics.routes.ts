import { Router, type Request, type Response, type NextFunction } from 'express';
import { ZodError } from 'zod';
import { requireAuth, requirePermission } from '../auth/auth.middleware.js';
import { analyticsFilterSchema } from './analytics.schema.js';
import { getAnalyticsDashboard, streamAnalyticsCsv, ANALYTICS_TIME_ZONE } from './analytics.service.js';

export const analyticsRouter = Router();

analyticsRouter.use(requireAuth);
analyticsRouter.use(requirePermission('cases:read'));

analyticsRouter.get('/dashboard', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filters = analyticsFilterSchema.parse(req.query);
    const data = await getAnalyticsDashboard(filters);
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

analyticsRouter.get('/export', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filters = analyticsFilterSchema.parse(req.query);
    const dateStr = new Intl.DateTimeFormat('sv-SE', { timeZone: ANALYTICS_TIME_ZONE }).format(new Date());
    const filename = `sac-relatorio-operacional-${filters.period}-${dateStr}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');

    for await (const chunk of streamAnalyticsCsv(filters)) {
      res.write(chunk);
    }
    res.end();
  } catch (error) {
    next(error);
  }
});

analyticsRouter.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (error instanceof ZodError) return res.status(422).json({ error: { code: 'VALIDATION_ERROR', details: error.issues } });
  return next(error);
});
