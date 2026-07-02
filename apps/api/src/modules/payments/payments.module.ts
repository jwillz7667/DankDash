/**
 * Payments feature module — composes the Aeropay adapter chain and the
 * payment-methods + refunds surfaces.
 *
 * DI graph constructed here:
 *
 *   AeropayAuth                      (token-cache + HTTP + client creds)
 *      └──► AeropayClient            (REST surface used by service + Phase 6.3 checkout)
 *      └──► AeropayWebhookVerifier   (HMAC verifier used by the webhook controller)
 *      └──► PaymentMethodsService    (link, delete, webhook → ledger;
 *                                      also routes dispensary bank + payout
 *                                      webhook events to the two services below)
 *      └──► DispensaryBankLinkService (vendor bank link start/status +
 *                                      bank_account.* → dispensaries.aeropay_account_ref)
 *      └──► PayoutWebhookService     (payout.paid/failed → payouts row completion)
 *      └──► RefundsService           (vendor initiate, admin approve,
 *                                      Aeropay reverse-ACH, reverse ledger)
 *      └──► PaymentMethodsController + AeropayWebhookController
 *      └──► VendorRefundsController  + VendorPayoutAccountController
 *      └──► AdminRefundsController
 *
 * DispensariesModule additionally exports DispensariesRepository, which
 * DispensaryBankLinkService injects to persist the confirmed payout bank
 * account ref onto the dispensary.
 *
 * The undici dispatcher, ioredis-backed token cache, and HttpClient are
 * built once per process (no Scope.REQUEST) — Aeropay tokens are
 * fleet-shared and the HTTP pool reuses sockets. Tests bypass the module
 * entirely and inject hand-rolled fakes into the service/controller
 * constructors.
 *
 * DispensariesModule is imported so the vendor refunds controller's
 * VendorContextGuard resolves the same DispensaryStaffRepository
 * singleton the listings vendor surface uses — symmetric with how
 * ListingsModule wires the guard.
 *
 * OrdersModule is imported for its exported OrderTransitionService — the
 * single chokepoint for orders.status changes. PaymentMethodsService routes
 * the Aeropay `payment.failed` webhook through it (event `PAYMENT_FAILED`)
 * rather than updating the row directly, so the post-commit
 * OrderTransitionedEvent fires and customers/vendors see the failure surface.
 * NestJS exports are not transitive, so this pulls in only OrdersService +
 * OrderTransitionService, not OrdersModule's controllers or ListingsModule.
 *
 * Why module-level FactoryProviders instead of @Injectable() classes:
 * the aeropay package is plain-TS (no Nest decorators) so each
 * dependency is a constructor call rather than a DI-managed class. A
 * FactoryProvider keeps the construction order explicit and visible —
 * matters more than the slight extra ceremony.
 */
import {
  AeropayAuth,
  AeropayClient,
  AeropayWebhookVerifier,
  HttpClient,
  createUndiciDispatcher,
  type TokenCache,
} from '@dankdash/aeropay';
import {
  DispensariesRepository,
  DriversRepository,
  LedgerEntriesRepository,
  OrdersRepository,
  PaymentMethodsRepository,
  PaymentTransactionsRepository,
  PayoutsRepository,
  RefundsRepository,
  WebhookEventsProcessedRepository,
  type Database,
} from '@dankdash/db';
import { Module, type FactoryProvider, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { createDisabledFeatureProxy } from '../../common/disabled-feature.proxy.js';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { REDIS_CLIENT } from '../../infrastructure/redis.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DispensariesModule } from '../dispensaries/dispensaries.module.js';
import { VendorContextGuard } from '../listings/vendor/vendor-context.guard.js';
import { OrderTransitionService } from '../orders/order-transition.service.js';
import { OrdersModule } from '../orders/orders.module.js';
import { AdminRefundsController } from './admin-refunds.controller.js';
import { AeropayWebhookController } from './aeropay-webhook.controller.js';
import { DispensaryBankLinkService } from './dispensary-bank-link.service.js';
import { DriverBankLinkService } from './driver-bank-link.service.js';
import { DriverPayoutAccountController } from './driver-payout-account.controller.js';
import { PaymentMethodsController } from './payment-methods.controller.js';
import {
  PaymentMethodsService,
  type SettlementScopedRepos,
  type SettlementScopedReposFactory,
} from './payment-methods.service.js';
import { PayoutWebhookService } from './payout-webhook.service.js';
import { RedisTokenCache } from './redis-token-cache.js';
import {
  RefundsService,
  type RefundScopedRepos,
  type RefundScopedReposFactory,
} from './refunds.service.js';
import { AEROPAY_CLIENT, AEROPAY_WEBHOOK_VERIFIER } from './tokens.js';
import { VendorPayoutAccountController } from './vendor-payout-account.controller.js';
import { VendorRefundsController } from './vendor-refunds.controller.js';

const TOKEN_CACHE = Symbol.for('AEROPAY_TOKEN_CACHE');
const AEROPAY_HTTP = Symbol.for('AEROPAY_HTTP_CLIENT');
const AEROPAY_AUTH = Symbol.for('AEROPAY_AUTH');

const tokenCacheProvider: FactoryProvider<TokenCache> = {
  provide: TOKEN_CACHE,
  inject: [REDIS_CLIENT],
  useFactory: (redis: Redis): TokenCache => new RedisTokenCache(redis),
};

const httpClientProvider: FactoryProvider<HttpClient> = {
  provide: AEROPAY_HTTP,
  inject: [],
  useFactory: (): HttpClient =>
    new HttpClient({
      dispatcher: createUndiciDispatcher({ maxConnections: 16, keepAliveTimeoutMs: 30_000 }),
    }),
};

// Aeropay providers are gated on `ENABLE_AEROPAY`. When the flag is off the
// factories yield disabled proxies so the DI graph is satisfied without
// requiring `AEROPAY_*` credentials at module construction; PaymentsModule
// still mounts (the payment-methods and refunds controllers remain
// addressable), but any code path that actually hits the proxies surfaces
// `503 FEATURE_DISABLED`.
const authProvider: FactoryProvider<AeropayAuth> = {
  provide: AEROPAY_AUTH,
  inject: [ConfigService, AEROPAY_HTTP, TOKEN_CACHE],
  useFactory: (config: ConfigService, http: HttpClient, cache: TokenCache): AeropayAuth => {
    if (!config.getOrThrow<boolean>('ENABLE_AEROPAY')) {
      return createDisabledFeatureProxy<AeropayAuth>('aeropay');
    }
    return new AeropayAuth({
      clientId: config.getOrThrow<string>('AEROPAY_CLIENT_ID'),
      clientSecret: config.getOrThrow<string>('AEROPAY_CLIENT_SECRET'),
      apiBaseUrl: config.getOrThrow<string>('AEROPAY_API_BASE_URL'),
      http,
      cache,
    });
  },
};

const clientProvider: FactoryProvider<AeropayClient> = {
  provide: AEROPAY_CLIENT,
  inject: [ConfigService, AEROPAY_HTTP, AEROPAY_AUTH],
  useFactory: (config: ConfigService, http: HttpClient, auth: AeropayAuth): AeropayClient => {
    if (!config.getOrThrow<boolean>('ENABLE_AEROPAY')) {
      return createDisabledFeatureProxy<AeropayClient>('aeropay');
    }
    return new AeropayClient({
      apiBaseUrl: config.getOrThrow<string>('AEROPAY_API_BASE_URL'),
      http,
      auth,
    });
  },
};

const webhookVerifierProvider: FactoryProvider<AeropayWebhookVerifier> = {
  provide: AEROPAY_WEBHOOK_VERIFIER,
  inject: [ConfigService],
  useFactory: (config: ConfigService): AeropayWebhookVerifier => {
    if (!config.getOrThrow<boolean>('ENABLE_AEROPAY')) {
      return createDisabledFeatureProxy<AeropayWebhookVerifier>('aeropay');
    }
    return new AeropayWebhookVerifier({
      webhookSecret: config.getOrThrow<string>('AEROPAY_WEBHOOK_SECRET'),
    });
  },
};

const paymentMethodsRepoProvider: FactoryProvider<PaymentMethodsRepository> = {
  provide: PaymentMethodsRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): PaymentMethodsRepository => new PaymentMethodsRepository(db),
};

const paymentTransactionsRepoProvider: FactoryProvider<PaymentTransactionsRepository> = {
  provide: PaymentTransactionsRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): PaymentTransactionsRepository =>
    new PaymentTransactionsRepository(db),
};

const ordersRepoProvider: FactoryProvider<OrdersRepository> = {
  provide: OrdersRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): OrdersRepository => new OrdersRepository(db),
};

const payoutsRepoProvider: FactoryProvider<PayoutsRepository> = {
  provide: PayoutsRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): PayoutsRepository => new PayoutsRepository(db),
};

// DriverBankLinkService writes `aeropay_account_ref` on the driver (payout
// linking). PaymentsModule provides its own DriversRepository singleton
// rather than importing DriversModule — DriversModule already imports
// PaymentsModule (for AEROPAY_CLIENT), so importing back would form a cycle.
// The repo is a thin wrapper around the shared Database, so a second instance
// is free.
const driversRepoProvider: FactoryProvider<DriversRepository> = {
  provide: DriversRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): DriversRepository => new DriversRepository(db),
};

// DispensaryBankLinkService writes `aeropay_account_ref` on the dispensary
// (payout linking). It reuses the DispensariesRepository singleton exported
// by DispensariesModule (already imported for the VendorContextGuard) so the
// vendor bank-link surface and the admin dispensary surface share one repo.
const dispensaryBankLinkServiceProvider: FactoryProvider<DispensaryBankLinkService> = {
  provide: DispensaryBankLinkService,
  inject: [DispensariesRepository, AEROPAY_CLIENT],
  useFactory: (
    dispensaries: DispensariesRepository,
    client: AeropayClient,
  ): DispensaryBankLinkService => new DispensaryBankLinkService(dispensaries, client),
};

// DriverBankLinkService writes `aeropay_account_ref` on the driver row,
// looked up by `user_id`. Symmetric with dispensaryBankLinkServiceProvider.
const driverBankLinkServiceProvider: FactoryProvider<DriverBankLinkService> = {
  provide: DriverBankLinkService,
  inject: [DriversRepository, AEROPAY_CLIENT],
  useFactory: (drivers: DriversRepository, client: AeropayClient): DriverBankLinkService =>
    new DriverBankLinkService(drivers, client),
};

const payoutWebhookServiceProvider: FactoryProvider<PayoutWebhookService> = {
  provide: PayoutWebhookService,
  inject: [PayoutsRepository],
  useFactory: (payouts: PayoutsRepository): PayoutWebhookService =>
    new PayoutWebhookService(payouts),
};

// Closure factory used by PaymentMethodsService.handlePaymentSettled to
// re-bind the write repos to the transactional handle. Stateless — the
// same closure is reused for every webhook invocation; only the `db`
// passed in changes.
const settlementReposFor: SettlementScopedReposFactory = (db: Database): SettlementScopedRepos => ({
  paymentTransactions: new PaymentTransactionsRepository(db),
  ledgerEntries: new LedgerEntriesRepository(db),
});

// Closure factory used by RefundsService.finalize to keep the refund
// row update, payment_transactions status flip, and reverse-ledger
// writes inside one transaction. Same shape and rationale as
// `settlementReposFor` above.
const refundReposFor: RefundScopedReposFactory = (db: Database): RefundScopedRepos => ({
  refunds: new RefundsRepository(db),
  paymentTransactions: new PaymentTransactionsRepository(db),
  ledgerEntries: new LedgerEntriesRepository(db),
});

// Service is wired through a FactoryProvider rather than a class-token so we
// don't depend on SWC emitting `design:paramtypes` for the constructor.
// Symbol-token deps (AEROPAY_CLIENT) and class-token deps are passed
// positionally to the constructor in the order the class declares them.
const serviceProvider: FactoryProvider<PaymentMethodsService> = {
  provide: PaymentMethodsService,
  inject: [
    PaymentMethodsRepository,
    PaymentTransactionsRepository,
    OrdersRepository,
    OrderTransitionService,
    DRIZZLE_DB,
    AEROPAY_CLIENT,
    DispensaryBankLinkService,
    DriverBankLinkService,
    PayoutWebhookService,
  ],
  useFactory: (
    repo: PaymentMethodsRepository,
    paymentTransactions: PaymentTransactionsRepository,
    orders: OrdersRepository,
    orderTransitions: OrderTransitionService,
    db: Database,
    client: AeropayClient,
    dispensaryBankLink: DispensaryBankLinkService,
    driverBankLink: DriverBankLinkService,
    payoutWebhooks: PayoutWebhookService,
  ): PaymentMethodsService =>
    new PaymentMethodsService(
      repo,
      paymentTransactions,
      orders,
      orderTransitions,
      db,
      settlementReposFor,
      client,
      dispensaryBankLink,
      driverBankLink,
      payoutWebhooks,
    ),
};

const refundsRepoProvider: FactoryProvider<RefundsRepository> = {
  provide: RefundsRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): RefundsRepository => new RefundsRepository(db),
};

const webhookEventsRepoProvider: FactoryProvider<WebhookEventsProcessedRepository> = {
  provide: WebhookEventsProcessedRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): WebhookEventsProcessedRepository =>
    new WebhookEventsProcessedRepository(db),
};

const refundsServiceProvider: FactoryProvider<RefundsService> = {
  provide: RefundsService,
  inject: [
    OrdersRepository,
    PaymentTransactionsRepository,
    RefundsRepository,
    DRIZZLE_DB,
    AEROPAY_CLIENT,
  ],
  useFactory: (
    orders: OrdersRepository,
    paymentTransactions: PaymentTransactionsRepository,
    refunds: RefundsRepository,
    db: Database,
    client: AeropayClient,
  ): RefundsService =>
    new RefundsService(orders, paymentTransactions, refunds, db, refundReposFor, client),
};

const providers: Provider[] = [
  tokenCacheProvider,
  httpClientProvider,
  authProvider,
  clientProvider,
  webhookVerifierProvider,
  paymentMethodsRepoProvider,
  paymentTransactionsRepoProvider,
  ordersRepoProvider,
  payoutsRepoProvider,
  driversRepoProvider,
  refundsRepoProvider,
  webhookEventsRepoProvider,
  VendorContextGuard,
  dispensaryBankLinkServiceProvider,
  driverBankLinkServiceProvider,
  payoutWebhookServiceProvider,
  serviceProvider,
  refundsServiceProvider,
];

@Module({
  imports: [AuthModule, DispensariesModule, OrdersModule],
  controllers: [
    PaymentMethodsController,
    AeropayWebhookController,
    VendorRefundsController,
    VendorPayoutAccountController,
    DriverPayoutAccountController,
    AdminRefundsController,
  ],
  providers,
  exports: [PaymentMethodsService, RefundsService, AEROPAY_CLIENT],
})
export class PaymentsModule {}
