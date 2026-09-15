import { Router, type NextFunction, type Request, type Response } from 'express';
import { requireAuth, requirePermission } from '../auth/auth.middleware.js';
import { hasPermission } from '../../domain/permissions.js';
import {
  catalogEntrySchema, catalogStatusSchema, listCatalogSchema, listSubreasonsSchema,
  subreasonEntrySchema, updateCatalogEntrySchema, updateSubreasonEntrySchema,
} from './catalog.schema.js';
import {
  CatalogError, createChannel, createReason, createSubreason, getReason, listChannels,
  listReasons, listSubreasons, setChannelStatus, setReasonStatus, setSubreasonStatus,
  updateChannel, updateReason, updateSubreason,
} from './catalog.service.js';

export const catalogRouter = Router();
catalogRouter.use(requireAuth);

const isAdmin = (req: Request) => Boolean(req.auth && hasPermission(req.auth.role, 'catalogs:manage'));
const send = (res: Response, data: unknown, status = 200) => res.status(status).json({ data });
const route = (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => handler(req, res).catch(next);
export const deletionDisabled = (_req: Request, res: Response) => res.status(405).json({ error: { code: 'PERMANENT_DELETION_DISABLED', message: 'Use a inativação para preservar o histórico.' } });

catalogRouter.get('/reasons', route(async (req, res) => send(res, await listReasons(listCatalogSchema.parse(req.query), isAdmin(req)))));
catalogRouter.get('/reasons/:id', route(async (req, res) => send(res, await getReason(String(req.params.id), isAdmin(req)))));
catalogRouter.post('/reasons', requirePermission('catalogs:manage'), route(async (req, res) => send(res, await createReason(catalogEntrySchema.parse(req.body)), 201)));
catalogRouter.patch('/reasons/:id', requirePermission('catalogs:manage'), route(async (req, res) => send(res, await updateReason(String(req.params.id), updateCatalogEntrySchema.parse(req.body)))));
catalogRouter.patch('/reasons/:id/status', requirePermission('catalogs:manage'), route(async (req, res) => send(res, await setReasonStatus(String(req.params.id), catalogStatusSchema.parse(req.body).active))));
catalogRouter.delete('/reasons/:id', requirePermission('catalogs:manage'), deletionDisabled);

catalogRouter.get('/subreasons', route(async (req, res) => send(res, await listSubreasons(listSubreasonsSchema.parse(req.query), isAdmin(req)))));
catalogRouter.post('/subreasons', requirePermission('catalogs:manage'), route(async (req, res) => send(res, await createSubreason(subreasonEntrySchema.parse(req.body)), 201)));
catalogRouter.patch('/subreasons/:id', requirePermission('catalogs:manage'), route(async (req, res) => send(res, await updateSubreason(String(req.params.id), updateSubreasonEntrySchema.parse(req.body)))));
catalogRouter.patch('/subreasons/:id/status', requirePermission('catalogs:manage'), route(async (req, res) => send(res, await setSubreasonStatus(String(req.params.id), catalogStatusSchema.parse(req.body).active))));
catalogRouter.delete('/subreasons/:id', requirePermission('catalogs:manage'), deletionDisabled);

catalogRouter.get('/channels', route(async (req, res) => send(res, await listChannels(listCatalogSchema.parse(req.query), isAdmin(req)))));
catalogRouter.post('/channels', requirePermission('catalogs:manage'), route(async (req, res) => send(res, await createChannel(catalogEntrySchema.parse(req.body)), 201)));
catalogRouter.patch('/channels/:id', requirePermission('catalogs:manage'), route(async (req, res) => send(res, await updateChannel(String(req.params.id), updateCatalogEntrySchema.parse(req.body)))));
catalogRouter.patch('/channels/:id/status', requirePermission('catalogs:manage'), route(async (req, res) => send(res, await setChannelStatus(String(req.params.id), catalogStatusSchema.parse(req.body).active))));
catalogRouter.delete('/channels/:id', requirePermission('catalogs:manage'), deletionDisabled);

catalogRouter.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (error instanceof CatalogError) return res.status(error.status).json({ error: { code: error.code, message: error.message } });
  return next(error);
});
