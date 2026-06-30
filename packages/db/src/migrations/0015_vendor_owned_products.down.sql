-- Rollback for 0015_vendor_owned_products.
-- Drops the vendor-ownership marker. Any vendor-authored products become
-- indistinguishable from the global catalog again; if such rows exist they
-- should be tombstoned or reassigned before rolling back, since the public
-- browse filter (`created_by_dispensary_id IS NULL`) will start surfacing
-- them. No data restoration is otherwise needed.
DROP INDEX IF EXISTS "products_owner_idx";
--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN IF EXISTS "created_by_dispensary_id";
