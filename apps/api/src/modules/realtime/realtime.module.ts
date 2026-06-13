/**
 * Realtime feature module — owns the API-side fanout from
 * `OrderTransitionedEvent` onto the `dankdash:realtime` Redis Stream.
 *
 * Composes:
 *   - The OrderRealtimeListener that subscribes to
 *     `ORDER_TRANSITIONED_EVENT` and publishes `order:status_changed`
 *     envelopes onto the stream so the realtime service (apps/realtime)
 *     can fan them to its `/customer`, `/vendor`, and `/driver`
 *     namespaces.
 *
 * The module is event-bus only — no HTTP surface. It depends on the
 * global RedisModule (for the shared ioredis client) and on the
 * OrdersRepository (to resolve `customerId`, `dispensaryId`, and
 * `driverId` for the broadcast envelope, since the in-process event
 * payload carries only the orderId + status delta).
 */
import { OrdersRepository, type Database } from '@dankdash/db';
import { Module, type FactoryProvider, type Provider } from '@nestjs/common';
import { Redis } from 'ioredis';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { REDIS_CLIENT } from '../../infrastructure/redis.module.js';
import { OrderCreatedListener } from './order-created.listener.js';
import { OrderRealtimeListener } from './order-realtime.listener.js';

const ordersRepoProvider: FactoryProvider<OrdersRepository> = {
  provide: OrdersRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): OrdersRepository => new OrdersRepository(db),
};

const listenerProvider: FactoryProvider<OrderRealtimeListener> = {
  provide: OrderRealtimeListener,
  inject: [REDIS_CLIENT, OrdersRepository],
  useFactory: (redis: Redis, orders: OrdersRepository): OrderRealtimeListener =>
    new OrderRealtimeListener({ redis, orders }),
};

const orderCreatedListenerProvider: FactoryProvider<OrderCreatedListener> = {
  provide: OrderCreatedListener,
  inject: [REDIS_CLIENT],
  useFactory: (redis: Redis): OrderCreatedListener => new OrderCreatedListener({ redis }),
};

const providers: Provider[] = [ordersRepoProvider, listenerProvider, orderCreatedListenerProvider];

@Module({
  providers,
  exports: [OrderRealtimeListener, OrderCreatedListener],
})
export class RealtimeModule {}
