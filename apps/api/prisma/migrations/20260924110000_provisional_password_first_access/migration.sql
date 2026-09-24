-- AlterEnum
ALTER TYPE "AdminAuditType" ADD VALUE 'PROVISIONAL_PASSWORD_GENERATED';
ALTER TYPE "AdminAuditType" ADD VALUE 'PROVISIONAL_PASSWORD_RESENT';

-- AlterTable
ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "provisionalPasswordHash" TEXT,
ADD COLUMN "provisionalPasswordCreatedAt" TIMESTAMP(3),
ADD COLUMN "provisionalPasswordExpiresAt" TIMESTAMP(3);
