-- Restores the pre-0008 partial-status index and drops `next_retry_at`.
-- The original index excluded `reconciled` only, which the worker no
-- longer relies on but the admin-side metrc dashboard does.

DROP INDEX IF EXISTS "metrc_transactions_failed_idx";
--> statement-breakpoint

DROP INDEX IF EXISTS "metrc_transactions_due_idx";
--> statement-breakpoint

CREATE INDEX "metrc_transactions_status_idx"
  ON "metrc_transactions" ("status")
  WHERE "status" != 'reconciled';
--> statement-breakpoint

ALTER TABLE "metrc_transactions" DROP COLUMN IF EXISTS "next_retry_at";
