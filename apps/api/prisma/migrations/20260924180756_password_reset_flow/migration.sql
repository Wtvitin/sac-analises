-- AlterEnum
ALTER TYPE "AdminAuditType" ADD VALUE 'PASSWORD_RESET_REQUESTED';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "passwordResetExpiresAt" TIMESTAMP(3),
ADD COLUMN     "passwordResetTokenHash" TEXT;
