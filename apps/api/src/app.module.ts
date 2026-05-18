/**
 * Root NestJS module. Composes:
 *   - ConfigModule       (validated env via @dankdash/config)
 *   - DrizzleModule      (@Global; Postgres pool + Drizzle Database token)
 *   - EncryptionModule   (@Global; AES-256-GCM column-encryption service)
 *   - HealthModule       (k8s/Railway liveness + readiness probes, public)
 *   - AuthModule         (register, login, refresh, logout, MFA — mounted /v1)
 *   - IdentityModule     (/me + Persona KYC start + webhook — mounted /v1)
 *
 * Cross-cutting concerns (filters, interceptors, pipes, the global
 * JwtAuthGuard) are bound in main.ts so any controller picks them up —
 * keeping the module file declarative.
 */
import { loadEnv } from '@dankdash/config';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DrizzleModule } from './infrastructure/drizzle.module.js';
import { EncryptionModule } from './infrastructure/encryption.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (raw: Record<string, unknown>) => loadEnv({ source: raw as NodeJS.ProcessEnv }),
      ignoreEnvFile: true, // env loading is the deployment's responsibility
    }),
    DrizzleModule,
    EncryptionModule,
    HealthModule,
    AuthModule,
    IdentityModule,
  ],
})
export class AppModule {}
