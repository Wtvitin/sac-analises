-- Persist the current cancellation reason for operational queries and reports.
ALTER TABLE "SacRecord"
  ADD COLUMN "cancellationReason" TEXT;

-- Support chronological comment loading without changing existing data.
CREATE INDEX "Comment_recordId_createdAt_idx" ON "Comment"("recordId", "createdAt");
