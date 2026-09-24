import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';
import {
  createDocumentImport,
  getDocumentImport,
  cancelDocumentImport,
  revealDocumentImportField,
  DocumentImportError,
} from './document-import.service.js';

export const documentImportRouter = Router();

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
    let { index, fieldName, fieldPath } = req.body || {};
    if (typeof fieldPath === 'string') {
      if (fieldPath.startsWith('additionalInfo.')) {
        const parsed = parseInt(fieldPath.replace('additionalInfo.', ''), 10);
        if (!isNaN(parsed)) index = parsed;
      } else {
        fieldName = fieldPath;
      }
    }
    const result = await revealDocumentImportField(id, { index, fieldName }, userId, userRole);
    res.json({
      data: {
        ...result,
        revealedValue: result.value,
        fieldPath: fieldPath || (typeof index === 'number' ? `additionalInfo.${index}` : fieldName),
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
