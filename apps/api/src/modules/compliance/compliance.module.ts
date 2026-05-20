/**
 * Compliance feature module.
 *
 * Hosts the cross-cutting compliance reactors that subscribe to domain
 * events from other modules. Today this is just the Metrc enqueue
 * listener (Phase 11) — future additions include the COA recheck
 * trigger and the dispensary-license expiry watcher.
 *
 * No HTTP surface: this module is event-bus-only. Controllers that
 * expose compliance reads (e.g. admin views of `compliance_checks` or
 * `metric_transactions`) live in the dispensary admin module.
 *
 * Wiring: the listener is constructed via FactoryProvider so its
 * `MetrcEnqueueListenerDeps` (pre-built repositories + the
 * `ENABLE_METRC` flag) can be assembled at boot from
 * `DRIZZLE_DB` + `ConfigService`. NestJS's EventEmitterModule
 * (registered globally in AppModule) discovers `@OnEvent`-decorated
 * methods on any instantiated provider — instantiating the listener is
 * the whole subscription wiring.
 */
import { MetrcTransactionsRepository, OrderItemsRepository, type Database } from '@dankdash/db';
import { Module, type FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { MetrcEnqueueListener } from './metrc-enqueue.listener.js';

const metrcEnqueueListenerProvider: FactoryProvider<MetrcEnqueueListener> = {
  provide: MetrcEnqueueListener,
  inject: [DRIZZLE_DB, ConfigService],
  useFactory: (db: Database, config: ConfigService): MetrcEnqueueListener =>
    new MetrcEnqueueListener({
      orderItems: new OrderItemsRepository(db),
      metric: new MetrcTransactionsRepository(db),
      enabled: config.getOrThrow<boolean>('ENABLE_METRC'),
    }),
};

@Module({
  providers: [metrcEnqueueListenerProvider],
})
export class ComplianceModule {}
