import type { UserRole } from '@prisma/client';

declare global {
  namespace Express {
    interface Request { auth?: { userId: string; role: UserRole; department?: string | null; sessionId: string } }
  }
}

export {};
