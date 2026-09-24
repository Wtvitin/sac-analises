-- CreateEnum
CREATE TYPE "SacReferenceType" AS ENUM ('ORDER', 'INVOICE', 'SERVICE_ORDER', 'PROTOCOL', 'ATTENDANCE', 'CUSTOMER_CODE', 'INTERNAL_DOC', 'OTHER');

-- AlterEnum
ALTER TYPE "AdminAuditType" ADD VALUE IF NOT EXISTS 'SENSITIVE_DATA_REVEALED';

-- AlterTable: Make orderNumber nullable (purely relaxing a constraint, exclusively additive)
ALTER TABLE "SacRecord" ALTER COLUMN "orderNumber" DROP NOT NULL;

-- CreateTable
CREATE TABLE "SacReference" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "type" "SacReferenceType" NOT NULL,
    "value" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SacReference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SacReference_recordId_idx" ON "SacReference"("recordId");

-- CreateIndex
CREATE INDEX "SacReference_type_value_idx" ON "SacReference"("type", "value");

-- AddForeignKey
ALTER TABLE "SacReference" ADD CONSTRAINT "SacReference_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "SacRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: For existing SacRecord rows that have orderNumber, add a reference of type ORDER
INSERT INTO "SacReference" ("id", "recordId", "type", "value", "createdAt")
SELECT 'ref_ord_' || substr(md5(random()::text || clock_timestamp()::text), 1, 20), "id", 'ORDER'::"SacReferenceType", "orderNumber", CURRENT_TIMESTAMP
FROM "SacRecord"
WHERE "orderNumber" IS NOT NULL AND TRIM("orderNumber") <> '';

-- Backfill: For existing SacRecord rows that have externalTicket, add a reference of type ATTENDANCE
INSERT INTO "SacReference" ("id", "recordId", "type", "value", "createdAt")
SELECT 'ref_att_' || substr(md5(random()::text || clock_timestamp()::text), 1, 20), "id", 'ATTENDANCE'::"SacReferenceType", "externalTicket", CURRENT_TIMESTAMP
FROM "SacRecord"
WHERE "externalTicket" IS NOT NULL AND TRIM("externalTicket") <> '';
