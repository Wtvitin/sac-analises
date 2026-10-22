import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { requireAuth, requirePermission, requireRole } from '../auth/auth.middleware.js';
import {
  createDocumentImport,
  getDocumentImport,
  cancelDocumentImport,
  revealDocumentImportField,
  DocumentImportError,
} from './document-import.service.js';

export const documentImportRouter = Router();

const importUploadUserLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 25,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => (req.auth?.userId ? `user:${req.auth.userId}` : ipKeyGenerator(req.ip || '127.0.0.1')),
  handler: (_req: Request, res: Response) => res.status(429).json({
    error: { code: 'TOO_MANY_REQUESTS', message: 'Muitas importações enviadas por este usuário. Aguarde antes de enviar novamente.' },
  }),
});

const importUploadIpLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => res.status(429).json({
    error: { code: 'TOO_MANY_REQUESTS', message: 'Limite de importações por rede excedido. Aguarde antes de enviar novamente.' },
  }),
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
    files: 1,
  },
});

documentImportRouter.use(requireAuth);

documentImportRouter.post(
  '/',
  importUploadIpLimiter,
  importUploadUserLimiter,
  requirePermission('cases:write'),
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const file = req.file;
      const userId = req.auth!.userId;
      const session = await createDocumentImport(file, userId);
      res.status(201).json({ data: session });
    } catch (error) {
      if (error instanceof DocumentImportError) {
        res.status(error.status).json({ error: { code: error.code, message: error.message } });
        return;
      }
      next(error);
    }
  }
);

documentImportRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const userId = req.auth!.userId;
    const userRole = req.auth!.role;
    const session = await getDocumentImport(id, userId, userRole);
    res.json({ data: session });
  } catch (error) {
    if (error instanceof DocumentImportError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    next(error);
  }
});

documentImportRouter.post('/:id/reveal', requireRole('ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const userId = req.auth!.userId;
    const userRole = req.auth!.role;
    let { index, fieldName, fieldPath, fileIndex } = req.body || {};
    if (typeof fieldPath === 'string') {
      if (fieldPath.startsWith('additionalInfo.')) {
        const parsed = parseInt(fieldPath.replace('additionalInfo.', ''), 10);
        if (!isNaN(parsed)) index = parsed;
      } else if (fieldPath.startsWith('referencedFiles.')) {
        const parsed = parseInt(fieldPath.replace('referencedFiles.', ''), 10);
        if (!isNaN(parsed)) {
          fileIndex = parsed;
          fieldName = 'referencedFiles';
        }
      } else {
        fieldName = fieldPath;
      }
    }
    const result = await revealDocumentImportField(id, { index, fieldName, fileIndex }, userId, userRole);
    const resolvedFieldPath = fieldPath || (
      fieldName === 'referencedFiles' || typeof fileIndex === 'number'
        ? `referencedFiles.${fileIndex ?? index}`
        : typeof index === 'number'
          ? `additionalInfo.${index}`
          : fieldName
    );
    res.json({
      data: {
        ...result,
        revealedValue: result.value,
        fieldPath: resolvedFieldPath,
      },
    });
  } catch (error) {
    if (error instanceof DocumentImportError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    next(error);
  }
});

documentImportRouter.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const userId = req.auth!.userId;
    const userRole = req.auth!.role;
    const result = await cancelDocumentImport(id, userId, userRole);
    res.json({ data: result });
  } catch (error) {
    if (error instanceof DocumentImportError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    next(error);
  }
});

