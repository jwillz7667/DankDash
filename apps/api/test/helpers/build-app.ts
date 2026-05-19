/**
 * Test-only NestJS application factory. Mirrors what main.ts does — same
 * adapter, same filters, pipes, interceptors, swagger off — but skips
 * `.listen()` so tests use `app.inject()` (no real port binding). Every
 * feature integration test uses this helper to get production-equivalent
 * wiring without paying for HTTP transport.
 *
 * The first import primes process.env so the AppModule's ConfigModule
 * validation passes — this MUST stay first.
 *
 * Provider overrides: tests that need to replace a real adapter with a
 * fake (e.g. the AEROPAY_CLIENT in the checkout flow integration test)
 * pass an `overrides` array. Each entry is a `{ token, value }` pair and
 * is applied via NestJS Testing's `overrideProvider(...).useValue(...)`
 * before the module compiles. Without overrides the helper short-circuits
 * to `NestFactory.create(AppModule, ...)` so the cold-path stays cheap.
 */
import './env-setup.js';
import helmet from '@fastify/helmet';
import { Logger } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { pino } from 'pino';
import { AppModule } from '../../src/app.module.js';
import { GlobalExceptionFilter } from '../../src/common/filters/global-exception.filter.js';
import { RateLimitGuard } from '../../src/common/guards/rate-limit.guard.js';
import { LoggingInterceptor } from '../../src/common/interceptors/logging.interceptor.js';
import { RequestIdInterceptor } from '../../src/common/interceptors/request-id.interceptor.js';
import { ZodValidationPipe } from '../../src/common/pipes/zod-validation.pipe.js';
import {
  RATE_LIMIT_STORE,
  type RateLimitStore,
} from '../../src/common/rate-limit/rate-limit-store.js';
import { JwtAuthGuard } from '../../src/modules/auth/guards/jwt-auth.guard.js';
import { JwtService } from '../../src/modules/auth/jwt/jwt.service.js';

export interface ProviderOverride {
  readonly token: unknown;
  readonly value: unknown;
}

export interface BuildTestAppOptions {
  readonly overrides?: readonly ProviderOverride[];
}

export async function buildTestApp(
  options: BuildTestAppOptions = {},
): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    logger: false,
    trustProxy: true,
    disableRequestLogging: true,
  });

  const overrides = options.overrides ?? [];
  const app = await (async (): Promise<NestFastifyApplication> => {
    if (overrides.length === 0) {
      return NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
        bufferLogs: true,
        abortOnError: false,
        rawBody: true,
      });
    }
    let builder = Test.createTestingModule({ imports: [AppModule] });
    for (const o of overrides) {
      builder = builder.overrideProvider(o.token).useValue(o.value);
    }
    const moduleRef = await builder.compile();
    return moduleRef.createNestApplication<NestFastifyApplication>(adapter, {
      bufferLogs: true,
      abortOnError: false,
      rawBody: true,
    });
  })();
  app.useLogger(new Logger());
  app.setGlobalPrefix('v1', { exclude: ['health', 'health/ready', 'health/live'] });
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });
  const logger = pino({ level: 'silent' });
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new GlobalExceptionFilter(logger));
  app.useGlobalInterceptors(new RequestIdInterceptor(), new LoggingInterceptor(logger));

  // Mirror main.ts: deny-by-default global auth + global rate limiting.
  // Tests that hit authenticated routes mint a token via the test rig and
  // pass it in Authorization. RateLimitGuard runs AFTER JwtAuthGuard so the
  // 'user' tracker can read req.user. In NODE_ENV=test the store binding
  // resolves to MemoryRateLimitStore — no Redis required.
  const reflector = app.get(Reflector);
  const jwtService = app.get(JwtService);
  const rateLimitStore = app.get<RateLimitStore>(RATE_LIMIT_STORE);
  app.useGlobalGuards(
    new JwtAuthGuard(reflector, jwtService),
    new RateLimitGuard(reflector, rateLimitStore),
  );

  await app.init();
  return app;
}
