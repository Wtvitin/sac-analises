-- AlterEnum
ALTER TYPE "AdminAuditType" ADD VALUE 'USER_DELETED';

-- DropForeignKey
ALTER TABLE "AdminAudit" DROP CONSTRAINT "AdminAudit_targetUserId_fkey";

-- AlterTable
ALTER TABLE "AdminAudit" ALTER COLUMN "targetUserId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "User_deletedAt_idx" ON "User"("deletedAt");

-- AddForeignKey
ALTER TABLE "AdminAudit" ADD CONSTRAINT "AdminAudit_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
