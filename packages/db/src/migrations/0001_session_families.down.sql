-- ============================================================================
-- DankDash — 0001_session_families (down)
-- Reverses the family columns + index added in 0001_session_families.sql.
-- ============================================================================

ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_rotation_consistent";
--> statement-breakpoint
DROP INDEX IF EXISTS "sessions_family_idx";
--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "rotated_to";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "rotated_at";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "family_id";
