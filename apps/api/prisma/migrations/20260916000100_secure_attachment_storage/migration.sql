-- Add secure attachment storage metadata, lifecycle tracking and author relations.
-- CreateEnum
CREATE TYPE "AttachmentStatus" AS ENUM ('ACTIVE', 'QUARANTINED', 'PENDING_DELETION');

-- AlterTable
ALTER TABLE "Attachment"
  ADD COLUMN "sha256" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "storageProvider" TEXT NOT NULL DEFAULT 'local',
  ADD COLUMN "status" "AttachmentStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "scanStatus" TEXT NOT NULL DEFAULT 'NOT_SCANNED',
  ADD COLUMN "authorId" TEXT,
  ADD COLUMN "deletedAt" TIMESTAMP(3),
  ADD COLUMN "deletedById" TEXT;

-- CreateIndex
CREATE INDEX "Attachment_recordId_status_idx" ON "Attachment"("recordId", "status");
CREATE INDEX "Attachment_storageKey_idx" ON "Attachment"("storageKey");
CREATE INDEX "Attachment_sha256_idx" ON "Attachment"("sha256");
CREATE INDEX "Attachment_authorId_idx" ON "Attachment"("authorId");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_deletedById_fkey"
  FOREIGN KEY ("deletedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
