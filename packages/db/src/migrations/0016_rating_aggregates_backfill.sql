-- ============================================================================
-- DankDash — 0016_rating_aggregates_backfill
--
-- Recompute `drivers.rating_avg/rating_count` and
-- `dispensaries.rating_avg/rating_count` from the authoritative per-order
-- ratings (`orders.driver_rating`, `orders.dispensary_rating`).
--
-- Why this exists: `POST /v1/orders/:id/rate` has always written the
-- per-order rating columns, but nothing ever aggregated them into the
-- `drivers`/`dispensaries` rollups the dispatch scorer and menu ranking read.
-- Those rollups therefore sat at their defaults (NULL avg, 0 count) — the
-- quality signal was inert. The application now folds each new rating into
-- the rollup incrementally (single race-safe UPDATE, same tx as the order
-- write). This migration seeds the rollups from the ratings that predate
-- that code so live increments start from a correct base.
--
-- The rollup is fully derivable from `orders`, so this is idempotent:
-- re-running it reproduces the same values. Arithmetic is Postgres `numeric`
-- (avg of smallint → numeric), `round(…, 2)` matched to the NUMERIC(3,2)
-- destination columns. `orders.driver_id` references the *user* row, so the
-- driver rollup joins on `drivers.user_id`.
--
-- Data-only: no schema object changes, no lock beyond the touched rows.
-- Prod carries few rated orders, so the full scan is cheap.
-- ============================================================================

UPDATE "dispensaries" AS d
SET "rating_avg" = agg."avg_rating",
    "rating_count" = agg."cnt",
    "updated_at" = now()
FROM (
  SELECT "dispensary_id",
         round(avg("dispensary_rating"), 2) AS "avg_rating",
         count(*)                           AS "cnt"
  FROM "orders"
  WHERE "dispensary_rating" IS NOT NULL
  GROUP BY "dispensary_id"
) AS agg
WHERE d."id" = agg."dispensary_id";
--> statement-breakpoint
UPDATE "drivers" AS dr
SET "rating_avg" = agg."avg_rating",
    "rating_count" = agg."cnt",
    "updated_at" = now()
FROM (
  SELECT "driver_id",
         round(avg("driver_rating"), 2) AS "avg_rating",
         count(*)                       AS "cnt"
  FROM "orders"
  WHERE "driver_rating" IS NOT NULL
    AND "driver_id" IS NOT NULL
  GROUP BY "driver_id"
) AS agg
WHERE dr."user_id" = agg."driver_id";
