/**
 * Payments feature module — composes the Aeropay adapter chain and the
 * payment-methods + refunds surfaces.
 *
 * DI graph constructed here:
 *
 *   AeropayAuth                      (token-cache + HTTP + client creds)
 *      └──► AeropayClient            (REST surface used by service + Phase 6.3 checkout)
 *      └──► AeropayWebhookVerifier   (HMAC verifier used by the webhook controller)
 *      └──► PaymentMethodsService    (link, delete, webhook → ledger)
 *      └──► RefundsService           (vendor initiate, admin approve,
 *                                      Aeropay reverse-ACH, reverse ledger)
 *      └──► PaymentMethodsController + AeropayWebhookController
 *      └──► VendorRefundsController  + AdminRefundsController
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
  LedgerEntriesRepository,
  OrdersRepository,
  PaymentMethodsRepository,
  PaymentTransactionsRepository,
  RefundsRepository,
  type Database,
} from '@dankdash/db';
import { Module, type FactoryProvider, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { REDIS_CLIENT } from '../../infrastructure/redis.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DispensariesModule } from '../dispensaries/dispensaries.module.js';
import { VendorContextGuard } from '../listings/vendor/vendor-context.guard.js';
import { AdminRefundsController } from './admin-refunds.controller.js';
import { AeropayWebhookController } from './aeropay-webhook.controller.js';
import { PaymentMethodsController } from './payment-methods.controller.js';
import {
  PaymentMethodsService,
  type SettlementScopedRepos,
  type SettlementScopedReposFactory,
} from './payment-methods.service.js';
import { RedisTokenCache } from './redis-token-cache.js';
import {
  RefundsService,
  type RefundScopedRepos,
  type RefundScopedReposFactory,
} from './refunds.service.js';
import { AEROPAY_CLIENT, AEROPAY_WEBHOOK_VERIFIER } from './tokens.js';
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

const authProvider: FactoryProvider<AeropayAuth> = {
  provide: AEROPAY_AUTH,
  inject: [ConfigService, AEROPAY_HTTP, TOKEN_CACHE],
  useFactory: (config: ConfigService, http: HttpClient, cache: TokenCache): AeropayAuth =>
    new AeropayAuth({
      clientId: config.getOrThrow<string>('AEROPAY_CLIENT_ID'),
      clientSecret: config.getOrThrow<string>('AEROPAY_CLIENT_SECRET'),
      apiBaseUrl: config.getOrThrow<string>('AEROPAY_API_BASE_URL'),
      http,
      cache,
    }),
};

const clientProvider: FactoryProvider<AeropayClient> = {
  provide: AEROPAY_CLIENT,
  inject: [ConfigService, AEROPAY_HTTP, AEROPAY_AUTH],
  useFactory: (config: ConfigService, http: HttpClient, auth: AeropayAuth): AeropayClient =>
    new AeropayClient({
      apiBaseUrl: config.getOrThrow<string>('AEROPAY_API_BASE_URL'),
      http,
      auth,
    }),
};

const webhookVerifierProvider: FactoryProvider<AeropayWebhookVerifier> = {
  provide: AEROPAY_WEBHOOK_VERIFIER,
  inject: [ConfigService],
  useFactory: (config: ConfigService): AeropayWebhookVerifier =>
    new AeropayWebhookVerifier({
      webhookSecret: config.getOrThrow<string>('AEROPAY_WEBHOOK_SECRET'),
    }),
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
    DRIZZLE_DB,
    AEROPAY_CLIENT,
  ],
  useFactory: (
    repo: PaymentMethodsRepository,
    paymentTransactions: PaymentTransactionsRepository,
    orders: OrdersRepository,
    db: Database,
    client: AeropayClient,
  ): PaymentMethodsService =>
    new PaymentMethodsService(repo, paymentTransactions, orders, db, settlementReposFor, client),
};

const refundsRepoProvider: FactoryProvider<RefundsRepository> = {
  provide: RefundsRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): RefundsRepository => new RefundsRepository(db),
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
  refundsRepoProvider,
  VendorContextGuard,
  serviceProvider,
  refundsServiceProvider,
];

@Module({
  imports: [AuthModule, DispensariesModule],
  controllers: [
    PaymentMethodsController,
    AeropayWebhookController,
    VendorRefundsController,
    AdminRefundsController,
  ],
  providers,
  exports: [PaymentMethodsService, RefundsService, AEROPAY_CLIENT],
})
export class PaymentsModule {}
