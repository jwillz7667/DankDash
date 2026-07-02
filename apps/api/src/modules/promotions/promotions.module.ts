/**
 * Promotions feature module — the vendor and admin promo-code surfaces.
 *
 * Both services are wired via FactoryProviders so each request builds its
 * tx-bound repositories from the injected `PromotionsScopedReposFactory`
 * (never mutating singleton fields — same rationale as the cart/listings
 * modules).
 *
 * DispensariesModule is imported for the DispensaryStaffRepository the
 * VendorContextGuard depends on (staff-membership check behind
 * X-Dispensary-Id); AuthModule for RolesGuard. The consumer apply/remove
 * endpoints live on the cart surface, not here.
 */
import { PromoCodesRepository, PromoRedemptionsRepository, type Database } from '@dankdash/db';
import { Module, type FactoryProvider } from '@nestjs/common';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DispensariesModule } from '../dispensaries/dispensaries.module.js';
import { VendorContextGuard } from '../listings/vendor/vendor-context.guard.js';
import { AdminPromotionsController } from './admin/admin-promotions.controller.js';
import { AdminPromotionsService } from './admin/admin-promotions.service.js';
import { VendorPromotionsController } from './vendor/vendor-promotions.controller.js';
import { VendorPromotionsService } from './vendor/vendor-promotions.service.js';
import type { PromotionsScopedRepos } from './promotions-repos.js';

const promotionsReposFactory = (scopedDb: Database): PromotionsScopedRepos => ({
  promoCodes: new PromoCodesRepository(scopedDb),
  promoRedemptions: new PromoRedemptionsRepository(scopedDb),
});

const vendorPromotionsServiceProvider: FactoryProvider<VendorPromotionsService> = {
  provide: VendorPromotionsService,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): VendorPromotionsService =>
    new VendorPromotionsService(db, promotionsReposFactory),
};

const adminPromotionsServiceProvider: FactoryProvider<AdminPromotionsService> = {
  provide: AdminPromotionsService,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): AdminPromotionsService =>
    new AdminPromotionsService(db, promotionsReposFactory),
};

@Module({
  imports: [AuthModule, DispensariesModule],
  controllers: [VendorPromotionsController, AdminPromotionsController],
  providers: [vendorPromotionsServiceProvider, adminPromotionsServiceProvider, VendorContextGuard],
  exports: [VendorPromotionsService, AdminPromotionsService],
})
export class PromotionsModule {}
