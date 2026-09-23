-- CreateEnum
CREATE TYPE "DocumentImportStatus" AS ENUM ('PROCESSING', 'READY_FOR_REVIEW', 'FAILED', 'CONFIRMED', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "DocumentImport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "status" "DocumentImportStatus" NOT NULL DEFAULT 'PROCESSING',
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "extractedData" JSONB,
    "error" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "recordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentImport_userId_status_idx" ON "DocumentImport"("userId", "status");

-- CreateIndex
CREATE INDEX "DocumentImport_sha256_idx" ON "DocumentImport"("sha256");

-- CreateIndex
CREATE INDEX "DocumentImport_expiresAt_idx" ON "DocumentImport"("expiresAt");

-- AddForeignKey
ALTER TABLE "DocumentImport" ADD CONSTRAINT "DocumentImport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
