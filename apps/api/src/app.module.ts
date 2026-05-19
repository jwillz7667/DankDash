/**
 * Root NestJS module. Composes:
 *   - ConfigModule       (validated env via @dankdash/config)
 *   - DrizzleModule      (@Global; Postgres pool + Drizzle Database token)
 *   - EncryptionModule   (@Global; AES-256-GCM column-encryption service)
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
 *
 * Cross-cutting concerns (filters, interceptors, pipes, the global
 * JwtAuthGuard, the global RateLimitGuard) are bound in main.ts so any
 * controller picks them up — keeping the module file declarative.
 */
import { loadEnv } from '@dankdash/config';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RateLimitModule } from './common/rate-limit/rate-limit.module.js';
import { DrizzleModule } from './infrastructure/drizzle.module.js';
import { EncryptionModule } from './infrastructure/encryption.module.js';
import { RedisModule } from './infrastructure/redis.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { CartModule } from './modules/cart/cart.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { CatalogCacheModule } from './modules/catalog-cache/catalog-cache.module.js';
import { CheckoutModule } from './modules/checkout/checkout.module.js';
import { DispensariesModule } from './modules/dispensaries/dispensaries.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { ListingsModule } from './modules/listings/listings.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { SearchModule } from './modules/search/search.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (raw: Record<string, unknown>) => loadEnv({ source: raw as NodeJS.ProcessEnv }),
      ignoreEnvFile: true, // env loading is the deployment's responsibility
    }),
    DrizzleModule,
    EncryptionModule,
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
  ],
})
export class AppModule {}
