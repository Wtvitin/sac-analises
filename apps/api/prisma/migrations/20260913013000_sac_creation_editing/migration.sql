-- Normalize minimal customers and prevent obvious concurrent duplicates.
ALTER TABLE "Customer"
  ADD COLUMN "normalizedName" TEXT NOT NULL;

-- Add creation idempotency, internal notes and a persistent channel reference.
-- The existing channel text remains as an immutable display snapshot for history.
ALTER TABLE "SacRecord"
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "internalNote" TEXT,
  ADD COLUMN "channelId" TEXT;

CREATE UNIQUE INDEX "Customer_normalizedName_key" ON "Customer"("normalizedName");
CREATE UNIQUE INDEX "SacRecord_idempotencyKey_key" ON "SacRecord"("idempotencyKey");
CREATE INDEX "SacRecord_externalTicket_idx" ON "SacRecord"("externalTicket");
CREATE INDEX "SacRecord_channelId_idx" ON "SacRecord"("channelId");

ALTER TABLE "SacRecord"
  ADD CONSTRAINT "SacRecord_channelId_fkey"
  FOREIGN KEY ("channelId") REFERENCES "Channel"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
