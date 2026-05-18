/**
 * Root NestJS module. Composes:
 *   - ConfigModule (validated env via @dankdash/config)
 *   - HealthModule (k8s/Railway liveness + readiness probes, public)
 *   - AuthModule, IdentityModule (feature modules; mounted under /v1 by
 *     the global prefix set in main.ts)
 *
 * Cross-cutting concerns (filters, interceptors, pipes) are bound globally
 * in main.ts so any controller picks them up — keeping the module file
 * declarative.
 */
import { loadEnv } from '@dankdash/config';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './modules/health/health.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (raw: Record<string, unknown>) => loadEnv({ source: raw as NodeJS.ProcessEnv }),
      ignoreEnvFile: true, // env loading is the deployment's responsibility
    }),
    HealthModule,
  ],
})
export class AppModule {}
