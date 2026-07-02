-- Reverse of 0020_promo_codes. Drops policies + RLS, revokes grants, removes
-- the order/cart columns and constraint, drops the tables, then the enum types.
DROP POLICY IF EXISTS promo_redemptions_vendor_isolation ON "promo_redemptions";
--> statement-breakpoint
ALTER TABLE "promo_redemptions" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS promo_codes_vendor_isolation ON "promo_codes";
--> statement-breakpoint
ALTER TABLE "promo_codes" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE SELECT, INSERT, UPDATE ON "promo_codes", "promo_redemptions" FROM app_vendor;
--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_promo_funding_consistency";
--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN IF EXISTS "discount_funded_by";
--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN IF EXISTS "promo_code_id";
--> statement-breakpoint
ALTER TABLE "carts" DROP COLUMN IF EXISTS "promo_code_id";
--> statement-breakpoint
DROP TABLE IF EXISTS "promo_redemptions";
--> statement-breakpoint
DROP TABLE IF EXISTS "promo_codes";
--> statement-breakpoint
DROP TYPE IF EXISTS "discount_funded_by";
--> statement-breakpoint
DROP TYPE IF EXISTS "promo_code_scope";
--> statement-breakpoint
DROP TYPE IF EXISTS "promo_code_type";
