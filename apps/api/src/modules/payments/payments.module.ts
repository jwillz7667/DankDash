/**
 * Payments feature module — composes the Aeropay adapter chain and the
 * payment-methods surface.
 *
 * DI graph constructed here:
 *
 *   AeropayAuth                      (token-cache + HTTP + client creds)
 *      └──► AeropayClient            (REST surface used by service + Phase 6.3 checkout)
 *      └──► AeropayWebhookVerifier   (HMAC verifier used by the webhook controller)
 *      └──► PaymentMethodsService    (business logic; consumes the client)
 *      └──► PaymentMethodsController + AeropayWebhookController
 *
 * The undici dispatcher, ioredis-backed token cache, and HttpClient are
 * built once per process (no Scope.REQUEST) — Aeropay tokens are
 * fleet-shared and the HTTP pool reuses sockets. Tests bypass the module
 * entirely and inject hand-rolled fakes into the service/controller
 * constructors.
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
  OrdersRepository,
  PaymentMethodsRepository,
  PaymentTransactionsRepository,
  type Database,
} from '@dankdash/db';
import { Module, type FactoryProvider, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { REDIS_CLIENT } from '../../infrastructure/redis.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AeropayWebhookController } from './aeropay-webhook.controller.js';
import { PaymentMethodsController } from './payment-methods.controller.js';
import { PaymentMethodsService } from './payment-methods.service.js';
import { RedisTokenCache } from './redis-token-cache.js';
import { AEROPAY_CLIENT, AEROPAY_WEBHOOK_VERIFIER } from './tokens.js';

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
    AEROPAY_CLIENT,
  ],
  useFactory: (
    repo: PaymentMethodsRepository,
    paymentTransactions: PaymentTransactionsRepository,
    orders: OrdersRepository,
    client: AeropayClient,
  ): PaymentMethodsService => new PaymentMethodsService(repo, paymentTransactions, orders, client),
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
  serviceProvider,
];

@Module({
  imports: [AuthModule],
  controllers: [PaymentMethodsController, AeropayWebhookController],
  providers,
  exports: [PaymentMethodsService, AEROPAY_CLIENT],
})
export class PaymentsModule {}
