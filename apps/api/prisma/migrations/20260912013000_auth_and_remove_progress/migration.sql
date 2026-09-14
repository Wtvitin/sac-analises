-- Add approval control for public registrations.
ALTER TABLE "User" ADD COLUMN "approvedAt" TIMESTAMP(3);

-- Case tracking is now based exclusively on status and immutable activity history.
ALTER TABLE "SacRecord" DROP COLUMN "stage";
DROP TYPE "InvestigationStage";

ALTER TYPE "SacStatus" ADD VALUE 'CANCELLED';

ALTER TABLE "SacRecord"
  ADD COLUMN "identifiedCause" TEXT,
  ADD COLUMN "correctiveAction" TEXT,
  ADD COLUMN "responsibleArea" TEXT;
