/**
 * Payouts feature module (Phase 15.3).
 *
 * Owns the vendor-portal payouts surface — `/v1/vendor/payouts` and
 * `/v1/vendor/payouts/:id`. Read-only endpoints scoped by
 * VendorContextGuard, which is provided by ListingsModule (the
 * dispensaries module is transitively imported via that path).
 *
 * The service is constructed with a scoped repo factory rather than
 * pre-bound singletons, matching the pattern AnalyticsModule + Listings
 * use. Two repos travel together (PayoutsRepository + OrdersRepository)
 * so the factory bundles them into one object — the same shape unit
 * tests inject as in-memory fakes.
 *
 * The actual payout *writes* (createIfAbsent, updateStatus) live in the
 * workers process — this module only exposes read paths for the portal.
 */
import { OrdersRepository, PayoutsRepository, type Database } from '@dankdash/db';
import { Module, type FactoryProvider } from '@nestjs/common';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ListingsModule } from '../listings/listings.module.js';
import { VendorPayoutsController } from './vendor/vendor-payouts.controller.js';
import { VendorPayoutsService, type PayoutsRepos } from './vendor/vendor-payouts.service.js';

const vendorPayoutsServiceProvider: FactoryProvider<VendorPayoutsService> = {
  provide: VendorPayoutsService,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): VendorPayoutsService =>
    new VendorPayoutsService(
      (): PayoutsRepos => ({
        payouts: new PayoutsRepository(db),
        orders: new OrdersRepository(db),
      }),
    ),
};

@Module({
  imports: [AuthModule, ListingsModule],
  controllers: [VendorPayoutsController],
  providers: [vendorPayoutsServiceProvider],
  exports: [VendorPayoutsService],
})
export class PayoutsModule {}
