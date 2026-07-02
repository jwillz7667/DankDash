/**
 * Cart feature module — composes the consumer cart surface.
 *
 * The service is wired via a FactoryProvider so the production module
 * passes the real repository constructors into the `CartScopedReposFactory`
 * closure (one of these per tx, never mutating singleton fields — see
 * cart.service.ts for the rationale). The DI container supplies the
 * Database; the closure constructs tx-bound repositories on demand.
 *
 * AuthModule is imported for RolesGuard (the controller's @UseGuards).
 * JwtAuthGuard is already bound globally in the root composition so any
 * non-@Public request reaches the controller with `req.user` populated.
 *
 * No dispensary-context guard (and no X-Dispensary-Id header) — carts
 * are user-owned, not vendor-scoped. The cart row carries the dispensary
 * id and the service enforces that any added listing matches it.
 */
import {
  CartItemsRepository,
  CartsRepository,
  DispensariesRepository,
  DispensaryListingsRepository,
  ProductsRepository,
  PromoCodesRepository,
  PromoRedemptionsRepository,
  UserAddressesRepository,
  UsersRepository,
  type Database,
} from '@dankdash/db';
import { Module, type FactoryProvider } from '@nestjs/common';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { CartController } from './cart.controller.js';
import { CartService, type CartScopedRepos } from './cart.service.js';

const cartServiceProvider: FactoryProvider<CartService> = {
  provide: CartService,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): CartService =>
    new CartService(
      db,
      (scopedDb): CartScopedRepos => ({
        carts: new CartsRepository(scopedDb),
        items: new CartItemsRepository(scopedDb),
        listings: new DispensaryListingsRepository(scopedDb),
        dispensaries: new DispensariesRepository(scopedDb),
        users: new UsersRepository(scopedDb),
        userAddresses: new UserAddressesRepository(scopedDb),
        products: new ProductsRepository(scopedDb),
        promoCodes: new PromoCodesRepository(scopedDb),
        promoRedemptions: new PromoRedemptionsRepository(scopedDb),
      }),
    ),
};

@Module({
  imports: [AuthModule],
  controllers: [CartController],
  providers: [cartServiceProvider],
  exports: [CartService],
})
export class CartModule {}
