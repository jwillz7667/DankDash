-- ============================================================================
-- DankDash — 0002_payment_canceled (down)
-- Postgres has no DROP VALUE for enums. The supported reversal pattern is:
--   1. Create a new enum without the value.
--   2. Move every column off the old type to the new type.
--   3. Drop the old type and rename the new one.
--
-- We require the precondition that no `payment_transactions.status` row is
-- 'canceled' before this runs — if any exist, the ALTER below fails with
-- "invalid input value for enum payment_status" and the migration aborts
-- atomically. Operators must hand-resolve canceled rows (move to 'failed'
-- with a recorded reason) before reversing.
-- ============================================================================

CREATE TYPE "public"."payment_status__new" AS ENUM (
  'initiated','authorized','settled','failed','refunded','partially_refunded'
);
--> statement-breakpoint

ALTER TABLE "payment_transactions"
  ALTER COLUMN "status" TYPE "public"."payment_status__new"
  USING "status"::text::"public"."payment_status__new";
--> statement-breakpoint

DROP TYPE "public"."payment_status";
--> statement-breakpoint

ALTER TYPE "public"."payment_status__new" RENAME TO "payment_status";
--> statement-breakpoint

ALTER TABLE "payment_transactions" DROP COLUMN IF EXISTS "canceled_at";
