import { Router, type NextFunction, type Request, type Response } from 'express';
import { requireAuth } from '../auth/auth.middleware.js';
import { getNotification, listNotifications, markAllNotificationsRead, markNotificationRead, NotificationError, unreadNotificationCount } from './notification.service.js';
import { notificationIdSchema, notificationListSchema } from './notification.schema.js';

export const notificationRouter = Router();
notificationRouter.use(requireAuth);
notificationRouter.get('/', async (req, res, next) => { try { res.json({ data: await listNotifications(req.auth!.userId, notificationListSchema.parse(req.query)) }); } catch (error) { next(error); } });
notificationRouter.get('/unread-count', async (req, res, next) => { try { res.json({ data: await unreadNotificationCount(req.auth!.userId) }); } catch (error) { next(error); } });
notificationRouter.patch('/read-all', async (req, res, next) => { try { res.json({ data: await markAllNotificationsRead(req.auth!.userId) }); } catch (error) { next(error); } });
notificationRouter.get('/:id', async (req, res, next) => { try { res.json({ data: await getNotification(req.auth!.userId, notificationIdSchema.parse(req.params.id)) }); } catch (error) { next(error); } });
notificationRouter.patch('/:id/read', async (req, res, next) => { try { res.json({ data: await markNotificationRead(req.auth!.userId, notificationIdSchema.parse(req.params.id)) }); } catch (error) { next(error); } });
notificationRouter.use((error: unknown, _req: Request, res: Response, next: NextFunction) => error instanceof NotificationError ? res.status(error.status).json({ error: { code: error.code, message: error.message } }) : next(error));
