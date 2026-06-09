/**
 * Checkout feature module.
 *
 * Composes the single most complex transactional surface in the API:
 * `POST /v1/carts/:id/checkout`. Wires the service via a FactoryProvider
 * so each request's transaction gets its own tx-bound repository set
 * (same closure pattern as cart.module.ts and listings.module.ts — see
 * checkout.service.ts for the rationale).
 *
 * AuthModule is imported for RolesGuard (the controller's @UseGuards).
 * JwtAuthGuard is already bound globally so any non-@Public request
 * reaches the controller with `req.user` populated.
 *
 * No dispensary-context guard / no X-Dispensary-Id header — checkout is
 * driven by the cart row's `dispensary_id`, not by a vendor scope.
 */
import {
  CartItemsRepository,
  CartsRepository,
  DispensariesRepository,
  DispensaryListingsRepository,
  LedgerEntriesRepository,
  OrderEventsRepository,
  OrderItemsRepository,
  OrdersRepository,
  PaymentMethodsRepository,
  PaymentTransactionsRepository,
  ProductsRepository,
  UserAddressesRepository,
  UsersRepository,
  type Database,
} from '@dankdash/db';
import { Module, type FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { AEROPAY_CLIENT, type AeropayClientLike } from '../payments/tokens.js';
import { CheckoutCapabilitiesController } from './checkout-capabilities.controller.js';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutService, type CheckoutScopedRepos } from './checkout.service.js';

/**
 * Builds the per-transaction repository set the checkout service binds to
 * `tx`. Exported so the checkout integration suite can construct a
 * CheckoutService against the real Postgres pool with the bypass flag
 * forced on — the env-driven flag is snapshotted at ConfigModule import
 * time and cannot be flipped per-test, so the integration test overrides
 * the provider directly and reuses this exact factory to avoid drift.
 */
export function createCheckoutScopedRepos(scopedDb: Database): CheckoutScopedRepos {
  return {
    carts: new CartsRepository(scopedDb),
    items: new CartItemsRepository(scopedDb),
    listings: new DispensaryListingsRepository(scopedDb),
    dispensaries: new DispensariesRepository(scopedDb),
    users: new UsersRepository(scopedDb),
    userAddresses: new UserAddressesRepository(scopedDb),
    products: new ProductsRepository(scopedDb),
    orders: new OrdersRepository(scopedDb),
    orderItems: new OrderItemsRepository(scopedDb),
    orderEvents: new OrderEventsRepository(scopedDb),
    paymentTransactions: new PaymentTransactionsRepository(scopedDb),
    paymentMethods: new PaymentMethodsRepository(scopedDb),
    ledgerEntries: new LedgerEntriesRepository(scopedDb),
  };
}

const checkoutServiceProvider: FactoryProvider<CheckoutService> = {
  provide: CheckoutService,
  inject: [DRIZZLE_DB, AEROPAY_CLIENT, ConfigService],
  useFactory: (db: Database, aeropay: AeropayClientLike, config: ConfigService): CheckoutService =>
    new CheckoutService(
      db,
      createCheckoutScopedRepos,
      aeropay,
      config.get<boolean>('PAYMENTS_BYPASS_ENABLED') ?? false,
    ),
};

@Module({
  imports: [AuthModule, PaymentsModule],
  controllers: [CheckoutController, CheckoutCapabilitiesController],
  providers: [checkoutServiceProvider],
  exports: [CheckoutService],
})
export class CheckoutModule {}
