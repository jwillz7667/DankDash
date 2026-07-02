-- Rollback for 0016_rating_aggregates_backfill.
--
-- Reset the rating rollups back to their pre-feature defaults (NULL avg,
-- 0 count) for exactly the rows the up-migration seeded. This is the honest
-- inverse: before this feature nothing ever wrote these columns, so every
-- row was provably at its default. Roll the application code back alongside
-- this migration — otherwise the incremental fold on `POST /rate` keeps
-- writing the rollups and this reset is immediately re-diverged. The rollup
-- is derivable from `orders`, so re-applying the up-migration fully restores
-- the aggregate at any time.
UPDATE "dispensaries" AS d
SET "rating_avg" = NULL,
    "rating_count" = 0,
    "updated_at" = now()
FROM (
  SELECT DISTINCT "dispensary_id"
  FROM "orders"
  WHERE "dispensary_rating" IS NOT NULL
) AS agg
WHERE d."id" = agg."dispensary_id";
--> statement-breakpoint
UPDATE "drivers" AS dr
SET "rating_avg" = NULL,
    "rating_count" = 0,
    "updated_at" = now()
FROM (
  SELECT DISTINCT "driver_id"
  FROM "orders"
  WHERE "driver_rating" IS NOT NULL
    AND "driver_id" IS NOT NULL
) AS agg
WHERE dr."user_id" = agg."driver_id";
