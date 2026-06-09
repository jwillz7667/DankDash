/**
 * apps/api entrypoint.
 *
 * Boots NestJS on the Fastify adapter, wires the global ConfigModule, JSON
 * logger, Swagger/OpenAPI document, helmet headers, graceful shutdown, and
 * the global pipes / filters / interceptors that every controller depends on.
 *
 * Runtime composition (top-down):
 *   tracing            — OTel SDK init (FIRST import; auto-instrumentations
 *                         monkey-patch http/pg/ioredis/fastify/socket.io at
 *                         require time, so this must beat any dependent
 *                         import)
 *   process            — Node 22, ESM
 *   NestFactory        — wires the module graph and DI container
 *   FastifyAdapter     — HTTP layer (Fastify 5 with Helmet plugin)
 *   AppModule          — root module, mounts feature modules under /v1
 *   pino               — log sink; PII redaction paths come from
 *                         @dankdash/config/logger.ts
 */
// MUST be the first non-type import — initOtel registers `require`-time
// monkey-patches against http/pg/ioredis/fastify/socket.io, so loading
// any of those modules before this line (directly or transitively
// through AppModule) silently disables instrumentation. Import order
// is enforced here intentionally over the lint rule.
/* eslint-disable import/order */
import { apiOtelHandle } from './infrastructure/tracing.js';
import { loadEnv } from '@dankdash/config';
import { registerGracefulShutdown } from '@dankdash/observability';
import helmet from '@fastify/helmet';
import { Logger } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter.js';
import { RateLimitGuard } from './common/guards/rate-limit.guard.js';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor.js';
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor.js';
import { ZodValidationPipe } from './common/pipes/zod-validation.pipe.js';
import { RATE_LIMIT_STORE, type RateLimitStore } from './common/rate-limit/rate-limit-store.js';
import { resolveLogger } from './infrastructure/logger.js';
import {
  EXCEPTION_COUNTERS,
  HTTP_HISTOGRAMS,
  SENTRY_HANDLE,
} from './infrastructure/observability.module.js';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard.js';
import { JwtService } from './modules/auth/jwt/jwt.service.js';
import type { ExceptionCounters, HttpHistograms, SentryHandle } from '@dankdash/observability';
/* eslint-enable import/order */

async function bootstrap(): Promise<void> {
  // Validate env early — fail fast on a misconfigured deployment before
  // Fastify starts accepting connections. CI typecheck/test paths set
  // allowPartial to avoid needing every production secret locally.
  const env = loadEnv({
    allowPartial: process.env['ALLOW_PARTIAL_ENV'] === '1',
  });
  const logger = resolveLogger(env);

  if (env.PAYMENTS_BYPASS_ENABLED) {
    logger.warn(
      'PAYMENTS_BYPASS_ENABLED is ON — checkout will SKIP the Aeropay charge and ' +
        'record `bypass` payments. This is a test-only mode for exercising the ' +
        'cross-app order flow; it must never run against real customers. ' +
        'Compliance checks are unaffected and still enforced.',
    );
  }

  const adapter = new FastifyAdapter({
    logger: false, // pino is the single source of structured logs
    trustProxy: true, // Railway sits behind a TCP proxy
    bodyLimit: 1_048_576, // 1 MiB — webhook bodies fit comfortably
    disableRequestLogging: true,
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
    abortOnError: false,
    // Required for the Persona webhook controller — HMAC verification must
    // run against the unmodified incoming bytes, so the JSON parser cannot
    // be the only path that sees the body.
    rawBody: true,
  });

  app.useLogger(new Logger());
  app.setGlobalPrefix('v1', { exclude: ['health', 'health/ready', 'health/live'] });
  app.enableShutdownHooks();

  await app.register(helmet, {
    contentSecurityPolicy: false, // API responds JSON; CSP belongs on the web tiers
    crossOriginEmbedderPolicy: false,
    // The API serves JSON and is never meant to be framed by any origin.
    // DENY is stricter than helmet's SAMEORIGIN default and is the
    // clickjacking guarantee the security header contract asserts.
    xFrameOptions: { action: 'deny' },
  });

  // CORS is an explicit exact-match origin allowlist (CORS_ALLOWED_ORIGINS),
  // never a wildcard. Only the browser clients need it — the vendor portal
  // and the consumer checkout web app; the native iOS apps are unaffected
  // (CORS is a browser concern). With no origins configured we leave CORS
  // off entirely rather than defaulting open. allowedHeaders covers the
  // custom headers the portal sends (X-Dispensary-Id for vendor context),
  // and exposedHeaders lets the browser read the request id and the 429
  // Retry-After hint.
  if (env.CORS_ALLOWED_ORIGINS.length > 0) {
    app.enableCors({
      origin: [...env.CORS_ALLOWED_ORIGINS],
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id', 'X-Dispensary-Id'],
      exposedHeaders: ['X-Request-Id', 'Retry-After'],
      maxAge: 600,
    });
    logger.info({ origins: env.CORS_ALLOWED_ORIGINS }, 'CORS allowlist enabled');
  } else {
    logger.warn('CORS disabled: CORS_ALLOWED_ORIGINS is empty');
  }

  // Resolve cross-cutting dependencies from the DI container up front so
  // both interceptor + guard registrations see the same instances the rest
  // of the app uses (HttpHistograms + Sentry are @Global singletons; the
  // guards need Reflector + JwtService + the rate-limit store).
  const reflector = app.get(Reflector);
  const jwtService = app.get(JwtService);
  const rateLimitStore = app.get<RateLimitStore>(RATE_LIMIT_STORE);
  const httpHistograms = app.get<HttpHistograms>(HTTP_HISTOGRAMS);
  const sentryHandle = app.get<SentryHandle>(SENTRY_HANDLE);
  const exceptionCounters = app.get<ExceptionCounters>(EXCEPTION_COUNTERS);

  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new GlobalExceptionFilter(logger, sentryHandle, exceptionCounters));
  app.useGlobalInterceptors(
    new RequestIdInterceptor(),
    new LoggingInterceptor(logger, httpHistograms),
  );

  // Bind JwtAuthGuard globally so deny-by-default applies: any new route is
  // authenticated unless it carries @Public. Order matters: RateLimitGuard
  // runs AFTER JwtAuthGuard so the 'user' tracker can read req.user; guards
  // execute in declaration order.
  app.useGlobalGuards(
    new JwtAuthGuard(reflector, jwtService),
    new RateLimitGuard(reflector, rateLimitStore),
  );

  // Swagger UI at /docs publishes the entire internal API surface — every
  // route, DTO shape, and the compliance-gated cart/checkout contract. In
  // production that is reconnaissance handed to an attacker, so mount it
  // only outside production, or when an operator explicitly opts in via
  // ENABLE_API_DOCS (e.g. a locked-down internal prod). A default
  // production deploy never exposes it.
  if (env.NODE_ENV !== 'production' || env.ENABLE_API_DOCS) {
    const swagger = new DocumentBuilder()
      .setTitle('DankDash API')
      .setDescription(
        'Internal API for the three DankDash clients (consumer, vendor portal, ' +
          'driver). Compliance-gated endpoints are documented in ' +
          'docs/spec/openapi-excerpt.yaml.',
      )
      .setVersion('1.0.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
      .build();
    SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, swagger));
    logger.info('OpenAPI docs mounted at /docs');
  }

  // Wire SIGTERM/SIGINT to flush OTel + Sentry before exit. Registered
  // before `app.listen` so a signal arriving mid-bootstrap still drains;
  // the bootstrap().catch at the bottom of this file owns the
  // listen-failure path so we don't leak signal handlers there either.
  registerGracefulShutdown({
    otel: apiOtelHandle,
    sentryClose: (timeoutMs) => sentryHandle.close(timeoutMs),
  });

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  logger.info({ port: env.PORT }, 'apps/api listening');
}

bootstrap().catch((err: unknown) => {
  // Bootstrap can fail before the structured logger exists (bad env, missing
  // module). Stderr is the only sink guaranteed to reach Railway's stream.
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  process.stderr.write(`fatal bootstrap error: ${message}\n`);
  process.exit(1);
});
