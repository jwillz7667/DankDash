-- Rollback for 0026_user_favorites.
-- Drops the favorites table and its enum type. Favorites are disposable
-- derived data, so there is nothing to preserve or backfill.
DROP TABLE IF EXISTS "user_favorites";
--> statement-breakpoint
DROP TYPE IF EXISTS "favoritable_type";
