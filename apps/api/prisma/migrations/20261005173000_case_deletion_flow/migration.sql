-- AlterEnum
ALTER TYPE "AdminAuditType" ADD VALUE 'CASE_DELETED';

-- AlterTable
ALTER TABLE "SacRecord" ADD COLUMN "deletedAt" TIMESTAMP(3),
ADD COLUMN "deletedById" TEXT,
ADD COLUMN "deletionReason" TEXT;

-- CreateIndex
CREATE INDEX "SacRecord_deletedAt_idx" ON "SacRecord"("deletedAt");

-- AddForeignKey
ALTER TABLE "SacRecord" ADD CONSTRAINT "SacRecord_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
