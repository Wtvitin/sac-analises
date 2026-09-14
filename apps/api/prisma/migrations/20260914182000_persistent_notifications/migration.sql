-- Persist user-scoped operational notifications without changing existing data.
CREATE TYPE "NotificationType" AS ENUM (
  'ASSIGNED', 'ASSIGNEE_CHANGED', 'COMMENT_ADDED', 'STATUS_CHANGED',
  'PRIORITY_RAISED', 'DUE_DATE_CHANGED', 'NEAR_DUE', 'DUE_TODAY',
  'OVERDUE', 'STALE', 'UNASSIGNED', 'REOPENED', 'CANCELLED', 'COMPLETED'
);

CREATE TABLE "Notification" (
  "id" TEXT NOT NULL,
  "recipientId" TEXT NOT NULL,
  "recordId" TEXT,
  "type" "NotificationType" NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "metadata" JSONB,
  "dedupeKey" TEXT,
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");
CREATE INDEX "Notification_recipientId_createdAt_idx" ON "Notification"("recipientId", "createdAt");
CREATE INDEX "Notification_recipientId_readAt_createdAt_idx" ON "Notification"("recipientId", "readAt", "createdAt");
CREATE INDEX "Notification_recordId_idx" ON "Notification"("recordId");

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recipientId_fkey"
  FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recordId_fkey"
  FOREIGN KEY ("recordId") REFERENCES "SacRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;
