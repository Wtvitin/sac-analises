-- Track meaningful operational activity independently from technical updates.
ALTER TABLE "SacRecord"
  ADD COLUMN "lastOperationalActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Support stale-open-case filters without scanning the full records table.
CREATE INDEX "SacRecord_status_lastOperationalActivityAt_idx"
  ON "SacRecord"("status", "lastOperationalActivityAt");
