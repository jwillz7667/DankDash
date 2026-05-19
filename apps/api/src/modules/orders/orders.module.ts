/**
 * Orders feature module.
 *
 * Exposes two HTTP surfaces:
 *   - `CustomerOrdersController` (/v1/orders) — list, read, cancel, rate
 *   - `VendorOrdersController` (/v1/vendor/orders) — accept, reject, prepped,
 *     ready, handoff
 *
 * Both ultimately funnel state changes through `OrderTransitionService`,
 * which is the **single chokepoint** for every UPDATE to `orders.status`
 * and every INSERT into `order_events` / `order_status_history` (see the
 * comment block at the top of `order-transition.service.ts` for the full
 * contract). The non-transition read path and the post-delivery rating
 * write go through `OrdersService`.
 *
 * Wiring notes:
 *   - Both services are constructed via FactoryProvider so each per-request
 *     transaction gets its own tx-bound repository set — same closure
 *     pattern as cart.module.ts / checkout.module.ts / listings.module.ts.
 *   - `EventEmitterModule.forRoot()` is intentionally NOT imported here —
 *     it's registered globally in `AppModule` so every feature module can
 *     emit/subscribe to typed domain events without redundant imports.
 *   - `AuthModule` for RolesGuard. `ListingsModule` re-exports
 *     `VendorContextGuard` (the X-Dispensary-Id header reader) for the
 *     vendor controller's @UseGuards.
 *   - `DispensariesModule` is transitively imported via ListingsModule
 *     for the staff-membership lookup the VendorContextGuard performs;
 *     we do not import it directly to avoid stacking two copies of the
 *     DispensaryStaffRepository provider.
 */
import { OrdersRepository, type Database } from '@dankdash/db';
import { Module, type FactoryProvider } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ListingsModule } from '../listings/listings.module.js';
import { CustomerOrdersController } from './customer-orders.controller.js';
import {
  OrderTransitionService,
  type OrderScopedReposFactory,
  type ScopedOrderRepos,
} from './order-transition.service.js';
import {
  OrdersService,
  type OrdersScopedReposFactory,
  type OrdersScopedRepos,
} from './orders.service.js';
import { VendorOrdersController } from './vendor-orders.controller.js';

const ordersReposFactory: OrdersScopedReposFactory = (db: Database): OrdersScopedRepos => ({
  orders: new OrdersRepository(db),
});

const ordersServiceProvider: FactoryProvider<OrdersService> = {
  provide: OrdersService,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): OrdersService => new OrdersService(db, ordersReposFactory),
};

const transitionReposFactory: OrderScopedReposFactory = (db: Database): ScopedOrderRepos => ({
  orders: new OrdersRepository(db),
});

const orderTransitionServiceProvider: FactoryProvider<OrderTransitionService> = {
  provide: OrderTransitionService,
  inject: [DRIZZLE_DB, EventEmitter2],
  useFactory: (db: Database, events: EventEmitter2): OrderTransitionService =>
    new OrderTransitionService(db, transitionReposFactory, events),
};

@Module({
  imports: [AuthModule, ListingsModule],
  controllers: [CustomerOrdersController, VendorOrdersController],
  providers: [ordersServiceProvider, orderTransitionServiceProvider],
  exports: [OrdersService, OrderTransitionService],
})
export class OrdersModule {}
