-- Add secure user lifecycle fields and append-only administrative auditing.
ALTER TYPE "NotificationType" ADD VALUE 'ACCESS_REQUEST' BEFORE 'ASSIGNED';

CREATE TYPE "AdminAuditType" AS ENUM (
  'ACCESS_REQUESTED', 'ACCESS_APPROVED', 'ACCESS_REJECTED', 'ROLE_CHANGED',
  'USER_DEACTIVATED', 'USER_REACTIVATED', 'CASES_TRANSFERRED',
  'PASSWORD_CHANGED', 'LAST_ADMIN_BLOCKED'
);

ALTER TABLE "User"
  ADD COLUMN "approvedById" TEXT,
  ADD COLUMN "rejectedAt" TIMESTAMP(3),
  ADD COLUMN "rejectionReason" TEXT,
  ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastLoginAt" TIMESTAMP(3);

CREATE TABLE "AdminAudit" (
  "id" TEXT NOT NULL,
  "type" "AdminAuditType" NOT NULL,
  "actorId" TEXT,
  "targetUserId" TEXT NOT NULL,
  "justification" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "User_active_approvedAt_rejectedAt_idx" ON "User"("active", "approvedAt", "rejectedAt");
CREATE INDEX "User_role_active_approvedAt_idx" ON "User"("role", "active", "approvedAt");
CREATE INDEX "AdminAudit_targetUserId_createdAt_idx" ON "AdminAudit"("targetUserId", "createdAt");
CREATE INDEX "AdminAudit_actorId_createdAt_idx" ON "AdminAudit"("actorId", "createdAt");
CREATE INDEX "AdminAudit_type_createdAt_idx" ON "AdminAudit"("type", "createdAt");

ALTER TABLE "User" ADD CONSTRAINT "User_approvedById_fkey"
  FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdminAudit" ADD CONSTRAINT "AdminAudit_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdminAudit" ADD CONSTRAINT "AdminAudit_targetUserId_fkey"
  FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
