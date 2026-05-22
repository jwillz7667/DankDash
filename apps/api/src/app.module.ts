/**
 * Root NestJS module. Composes:
 *   - ConfigModule       (validated env via @dankdash/config)
 *   - DrizzleModule      (@Global; Postgres pool + Drizzle Database token)
 *   - EncryptionModule   (@Global; AES-256-GCM column-encryption service)
 *   - DocumentHashModule (@Global; HMAC-SHA256 document-number hasher for
 *                         license / ID-document `bytea` columns)
 *   - RedisModule        (@Global; shared ioredis client + lifecycle)
 *   - RateLimitModule    (@Global; binds the RateLimitStore the guard reads)
 *   - CatalogCacheModule (@Global; Redis-backed read-through cache for the
 *                         public dispensary feed + per-dispensary menu, 60s
 *                         TTL with versioned keys + explicit invalidation)
 *   - HealthModule       (k8s/Railway liveness + readiness probes, public)
 *   - AuthModule         (register, login, refresh, logout, MFA — mounted /v1)
 *   - IdentityModule     (/me + Persona KYC start + webhook — mounted /v1)
 *   - DispensariesModule (public dispensary list/read + admin CRUD — /v1)
 *   - CatalogModule      (products, categories, lab results — /v1 + /v1/admin)
 *   - ListingsModule     (vendor-scoped listings with RLS — /v1/vendor)
 *   - SearchModule       (product search + dispensary discovery feed — /v1)
 *   - CartModule         (consumer cart CRUD, user-owned, dispensary-scoped — /v1)
 *   - CheckoutModule     (POST /v1/carts/:id/checkout — the atomic checkout txn)
 *   - PaymentsModule     (Aeropay client + payment-method CRUD + webhook — /v1)
 *   - OrdersModule       (order lifecycle / state-machine transitions — /v1
 *                         customer surface + /v1/vendor vendor surface)
 *   - EventEmitterModule (in-process domain events; OrdersModule emits
 *                         OrderTransitionedEvent that future Realtime /
 *                         Dispatch / Notifications modules will subscribe to)
 *   - DriversModule      (driver admin onboarding + DriverContextGuard for
 *                         driver-self routes — mounted /v1/admin and /v1/driver)
 *   - ComplianceModule   (event-bus only — Metrc enqueue listener that
 *                         creates a `metric_transactions` row in
 *                         `pending` on every order → `delivered`. The
 *                         worker (apps/workers) polls those rows on a
 *                         60s tick and submits to Metrc with retry +
 *                         reconciliation per spec §7.2.)
 *   - NotificationsModule (Phase 12: push-token CRUD under /v1/me +
 *                         the order-lifecycle notification listener
 *                         that fans out through the
 *                         @dankdash/notifications APNs/Twilio/Resend
 *                         providers. Tokens are APNs-only in v1.)
 *   - RealtimeModule     (Phase 14: event-bus only — subscribes to
 *                         OrderTransitionedEvent and republishes
 *                         `order:status_changed` envelopes onto the
 *                         `dankdash:realtime` Redis Stream so the
 *                         realtime service can fan to the /customer,
 *                         /vendor, and /driver Socket.io namespaces.)
 *
 * Cross-cutting concerns (filters, interceptors, pipes, the global
 * JwtAuthGuard, the global RateLimitGuard) are bound in main.ts so any
 * controller picks them up — keeping the module file declarative.
 */
import { loadEnv } from '@dankdash/config';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { RateLimitModule } from './common/rate-limit/rate-limit.module.js';
import { DocumentHashModule } from './infrastructure/document-hash.module.js';
import { DrizzleModule } from './infrastructure/drizzle.module.js';
import { EncryptionModule } from './infrastructure/encryption.module.js';
import { RedisModule } from './infrastructure/redis.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { CartModule } from './modules/cart/cart.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { CatalogCacheModule } from './modules/catalog-cache/catalog-cache.module.js';
import { CheckoutModule } from './modules/checkout/checkout.module.js';
import { ComplianceModule } from './modules/compliance/compliance.module.js';
import { DispensariesModule } from './modules/dispensaries/dispensaries.module.js';
import { DriversModule } from './modules/drivers/drivers.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { ListingsModule } from './modules/listings/listings.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { RealtimeModule } from './modules/realtime/realtime.module.js';
import { SearchModule } from './modules/search/search.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (raw: Record<string, unknown>) => loadEnv({ source: raw as NodeJS.ProcessEnv }),
      ignoreEnvFile: true, // env loading is the deployment's responsibility
    }),
    // Global in-process event bus. Wildcards enabled so subscribers can
    // listen on `order.*`; verboseMemoryLeak surfaces dropped subscribers
    // in dev (off in prod by default). Registered once at the root so any
    // feature module can emit/subscribe without an extra import.
    EventEmitterModule.forRoot({
      wildcard: true,
      delimiter: '.',
      maxListeners: 20,
      verboseMemoryLeak: false,
    }),
    DrizzleModule,
    EncryptionModule,
    DocumentHashModule,
    RedisModule,
    RateLimitModule,
    CatalogCacheModule,
    HealthModule,
    AuthModule,
    IdentityModule,
    DispensariesModule,
    CatalogModule,
    ListingsModule,
    SearchModule,
    CartModule,
    CheckoutModule,
    PaymentsModule,
    OrdersModule,
    DriversModule,
    ComplianceModule,
    NotificationsModule,
    RealtimeModule,
  ],
})
export class AppModule {}
