-- Add persistent, revocable authentication sessions without changing existing data.
ALTER TYPE "AdminAuditType" ADD VALUE 'LOGIN_SUCCEEDED';
ALTER TYPE "AdminAuditType" ADD VALUE 'ALL_SESSIONS_REVOKED';
ALTER TYPE "AdminAuditType" ADD VALUE 'SESSION_REUSE_DETECTED';

CREATE TABLE "AuthSession" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "familyId" TEXT NOT NULL,
  "refreshTokenHash" TEXT NOT NULL,
  "tokenVersion" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  "rotatedAt" TIMESTAMP(3),
  "replacedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuthSession_refreshTokenHash_key" ON "AuthSession"("refreshTokenHash");
CREATE UNIQUE INDEX "AuthSession_replacedById_key" ON "AuthSession"("replacedById");
CREATE INDEX "AuthSession_userId_revokedAt_expiresAt_idx" ON "AuthSession"("userId", "revokedAt", "expiresAt");
CREATE INDEX "AuthSession_familyId_revokedAt_idx" ON "AuthSession"("familyId", "revokedAt");

ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_replacedById_fkey"
  FOREIGN KEY ("replacedById") REFERENCES "AuthSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
