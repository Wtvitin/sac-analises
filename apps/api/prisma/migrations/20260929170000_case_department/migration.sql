-- AlterTable
ALTER TABLE "SacRecord" ADD COLUMN "department" TEXT;

-- CreateIndex
CREATE INDEX "SacRecord_department_idx" ON "SacRecord"("department");
