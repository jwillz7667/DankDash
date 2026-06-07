-- Rollback for 0013_listing_image_keys.
-- Drops the per-listing image override column; the public menu falls back to
-- the shared `products.image_keys` automatically, so no data restoration is
-- needed beyond removing the column.
ALTER TABLE "dispensary_listings" DROP COLUMN IF EXISTS "image_keys";
