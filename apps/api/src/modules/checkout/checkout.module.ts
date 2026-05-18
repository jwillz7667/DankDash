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
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { AEROPAY_CLIENT, type AeropayClientLike } from '../payments/tokens.js';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutService, type CheckoutScopedRepos } from './checkout.service.js';

const checkoutServiceProvider: FactoryProvider<CheckoutService> = {
  provide: CheckoutService,
  inject: [DRIZZLE_DB, AEROPAY_CLIENT],
  useFactory: (db: Database, aeropay: AeropayClientLike): CheckoutService =>
    new CheckoutService(
      db,
      (scopedDb): CheckoutScopedRepos => ({
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
      }),
      aeropay,
    ),
};

@Module({
  imports: [AuthModule, PaymentsModule],
  controllers: [CheckoutController],
  providers: [checkoutServiceProvider],
  exports: [CheckoutService],
})
export class CheckoutModule {}
