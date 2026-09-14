-- Extend the existing reason catalog without removing historical fields or data.
ALTER TABLE "Reason"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "displayOrder" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "normalizedName" TEXT NOT NULL;

-- Extend the existing subreason catalog without removing historical fields or data.
ALTER TABLE "Subreason"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "displayOrder" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "normalizedName" TEXT NOT NULL;

-- Add the persistent service-channel catalog. SacRecord.channel remains unchanged in this stage.
CREATE TABLE "Channel" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "description" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "displayOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Reason_normalizedName_key" ON "Reason"("normalizedName");
CREATE INDEX "Reason_active_displayOrder_name_idx" ON "Reason"("active", "displayOrder", "name");

CREATE UNIQUE INDEX "Subreason_reasonId_normalizedName_key" ON "Subreason"("reasonId", "normalizedName");
CREATE INDEX "Subreason_reasonId_active_displayOrder_name_idx" ON "Subreason"("reasonId", "active", "displayOrder", "name");

CREATE UNIQUE INDEX "Channel_name_key" ON "Channel"("name");
CREATE UNIQUE INDEX "Channel_normalizedName_key" ON "Channel"("normalizedName");
CREATE INDEX "Channel_active_displayOrder_name_idx" ON "Channel"("active", "displayOrder", "name");
