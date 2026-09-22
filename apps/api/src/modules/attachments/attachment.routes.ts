import { Router, type Request, type Response, type NextFunction } from 'express';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requirePermission } from '../auth/auth.middleware.js';
import { getStorageProvider, AttachmentStorageError } from '../../lib/storage/index.js';

export const attachmentRouter = Router();

attachmentRouter.get(
  '/:id/download',
  requireAuth,
  requirePermission('cases:read'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);

      // 1. Fetch attachment and related SAC record
      const attachment = await prisma.attachment.findUnique({
        where: { id },
        include: {
          record: {
            select: { id: true, ticket: true, archivedAt: true },
          },
        },
      });

      // 2. Access control and existence verification
      if (!attachment || attachment.record.archivedAt) {
        throw new AttachmentStorageError(
          'ATTACHMENT_NOT_FOUND',
          'Evidência não encontrada ou registro indisponível.',
          404
        );
      }

      // Check lifecycle status
      if (attachment.status === 'QUARANTINED' || attachment.status === 'PENDING_DELETION') {
        throw new AttachmentStorageError(
          'ATTACHMENT_UNAVAILABLE',
          'Esta evidência está temporariamente indisponível para download.',
          410
        );
      }

      const provider = getStorageProvider();
      const fileExists = await provider.exists(attachment.storageKey);
      if (!fileExists) {
        throw new AttachmentStorageError(
          'ATTACHMENT_NOT_FOUND',
          'Arquivo físico não encontrado no armazenamento.',
          404
        );
      }

      // 3. Security headers
      res.setHeader('Content-Type', attachment.mimeType);
      res.setHeader('Content-Length', String(attachment.sizeBytes));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');

      // Safe RFC 5987 / RFC 6266 filename header
      const asciiName = attachment.originalName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
      const utf8Name = encodeURIComponent(attachment.originalName);
      res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`);

      // 4. Stream response
      const stream = await provider.openReadStream(attachment.storageKey);

      stream.on('error', (err) => {
        if (!res.headersSent) {
          next(err);
        } else {
          res.destroy();
        }
      });

      stream.pipe(res);
    } catch (error) {
      next(error);
    }
  }
);

attachmentRouter.use(
  (error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof AttachmentStorageError) {
      return res.status(error.status).json({
        error: { code: error.code, message: error.message },
      });
    }
    return next(error);
  }
);
