-- ============================================================================
-- DankDash — 0001_session_families
-- Adds OWASP-pattern refresh-token family columns to `sessions`.
--
-- Goal: detect refresh-token reuse and invalidate the *entire chain* that
-- descended from the original login, not just the leaked token.
--
-- Mechanism (enforced in apps/api auth/jwt code, not the DB):
--   * Each login creates a session row with a fresh `family_id`.
--   * Each successful refresh inserts a NEW row that shares the family_id of
--     its predecessor, and stamps `rotated_at` + `rotated_to` on the
--     predecessor so we have a linkable audit trail.
--   * If a refresh arrives whose hash matches a row that already has
--     `rotated_at` set, that token has been used twice — set `revoked_at`
--     on every row sharing the family_id and reject the request.
--
-- The DB enforces structural invariants (FK, NOT NULL, indexes); the
-- detection logic lives in the application layer where it can be unit-tested.
-- ============================================================================

ALTER TABLE "sessions" ADD COLUMN "family_id" uuid;
ALTER TABLE "sessions" ADD COLUMN "rotated_at" timestamptz;
ALTER TABLE "sessions" ADD COLUMN "rotated_to" uuid REFERENCES "sessions"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- Backfill: every pre-existing session forms a family of one (its own id).
-- The CHECK below then enforces NOT NULL going forward without forcing a
-- destructive table rewrite if migration is applied to a populated DB.
UPDATE "sessions" SET "family_id" = "id" WHERE "family_id" IS NULL;
--> statement-breakpoint

ALTER TABLE "sessions" ALTER COLUMN "family_id" SET NOT NULL;
--> statement-breakpoint

-- Used by "revoke entire family on reuse" — must be O(log n) at refresh time.
CREATE INDEX "sessions_family_idx" ON "sessions" ("family_id") WHERE revoked_at IS NULL;
--> statement-breakpoint

-- A predecessor row that has been rotated must point at its successor; a row
-- that has not been rotated must have both columns NULL. Enforced at the DB
-- to catch any code path that forgets to populate the link.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_rotation_consistent"
  CHECK (("rotated_at" IS NULL) = ("rotated_to" IS NULL));
