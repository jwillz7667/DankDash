/**
 * Listings feature module.
 *
 * Owns dispensary-scoped pricing and inventory rows that bind a global
 * product to a specific dispensary at a specific price with a specific
 * quantity-on-hand. The vendor surface (list/create/patch/delete the
 * dispensary's own listings) is RLS-scoped via `SET LOCAL
 * app.current_dispensary_id` inside each operation's transaction, so a
 * future Phase that swaps the vendor surface onto an `app_vendor`
 * connection pool picks up RLS without touching the service. In the
 * current single-role deployment the application-layer
 * `WHERE dispensary_id = ?` in each repo method is the primary guard,
 * and cross-dispensary access surfaces as 404 (not 403) so a probing
 * call cannot distinguish "this listing does not exist" from "this
 * listing belongs to another vendor".
 *
 * AuthModule is imported so RolesGuard is available for the vendor
 * controller's @UseGuards(RolesGuard); DispensariesModule is imported so
 * the same DispensaryStaffRepository singleton serves the
 * VendorContextGuard staff-membership check that the admin dispensaries
 * controller already uses for activation/suspension. JwtAuthGuard is
 * already bound globally in the root composition and authenticates
 * every non-@Public request before the route-local guards run.
 *
 * VendorListingsService is constructed with the raw Database and a
 * scoped-repo factory rather than with the pool's repository singletons
 * — every operation runs inside a tx that needs tx-bound repos, and the
 * factory pattern keeps the service unit-testable.
 */
import { DispensaryListingsRepository, ProductsRepository, type Database } from '@dankdash/db';
import { Module, type FactoryProvider } from '@nestjs/common';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { CatalogCacheService } from '../catalog-cache/catalog-cache.service.js';
import { DispensariesModule } from '../dispensaries/dispensaries.module.js';
import { VendorContextGuard } from './vendor/vendor-context.guard.js';
import { VendorListingsController } from './vendor/vendor-listings.controller.js';
import { VendorListingsService, type ScopedRepos } from './vendor/vendor-listings.service.js';

const vendorListingsServiceProvider: FactoryProvider<VendorListingsService> = {
  provide: VendorListingsService,
  inject: [DRIZZLE_DB, CatalogCacheService],
  useFactory: (db: Database, cache: CatalogCacheService): VendorListingsService =>
    new VendorListingsService(
      db,
      (scopedDb): ScopedRepos => ({
        listings: new DispensaryListingsRepository(scopedDb),
        products: new ProductsRepository(scopedDb),
      }),
      cache,
    ),
};

@Module({
  imports: [AuthModule, DispensariesModule],
  controllers: [VendorListingsController],
  providers: [vendorListingsServiceProvider, VendorContextGuard],
  exports: [VendorListingsService, VendorContextGuard, DispensariesModule],
})
export class ListingsModule {}
