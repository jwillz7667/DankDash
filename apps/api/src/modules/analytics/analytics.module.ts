/**
 * Analytics feature module (Phase 15.2).
 *
 * Owns the vendor analytics surface — `/v1/vendor/analytics/sales` and
 * `/v1/vendor/analytics/products`. Both endpoints are read-only and
 * scoped by VendorContextGuard, which is provided by ListingsModule.
 *
 * The service is constructed with a scoped repo factory rather than a
 * pre-bound `AnalyticsRepository` singleton. The factory pattern keeps
 * the service unit-testable (tests pass an in-memory fake) and gives a
 * future Phase that swaps the vendor surface onto an `app_vendor`
 * connection pool a clean seam to inject the right pool without
 * touching the service.
 */
import { AnalyticsRepository, type Database } from '@dankdash/db';
import { Module, type FactoryProvider } from '@nestjs/common';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ListingsModule } from '../listings/listings.module.js';
import { VendorAnalyticsController } from './vendor/vendor-analytics.controller.js';
import { VendorAnalyticsService } from './vendor/vendor-analytics.service.js';

const vendorAnalyticsServiceProvider: FactoryProvider<VendorAnalyticsService> = {
  provide: VendorAnalyticsService,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): VendorAnalyticsService =>
    new VendorAnalyticsService(() => new AnalyticsRepository(db)),
};

@Module({
  imports: [AuthModule, ListingsModule],
  controllers: [VendorAnalyticsController],
  providers: [vendorAnalyticsServiceProvider],
  exports: [VendorAnalyticsService],
})
export class AnalyticsModule {}
