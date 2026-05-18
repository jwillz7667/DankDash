/**
 * Test-only NestJS application factory. Mirrors what main.ts does — same
 * adapter, same filters, pipes, interceptors, swagger off — but skips
 * `.listen()` so tests use `app.inject()` (no real port binding). Every
 * feature integration test uses this helper to get production-equivalent
 * wiring without paying for HTTP transport.
 *
 * The first import primes process.env so the AppModule's ConfigModule
 * validation passes — this MUST stay first.
 */
import './env-setup.js';
import helmet from '@fastify/helmet';
import { Logger } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { pino } from 'pino';
import { AppModule } from '../../src/app.module.js';
import { GlobalExceptionFilter } from '../../src/common/filters/global-exception.filter.js';
import { LoggingInterceptor } from '../../src/common/interceptors/logging.interceptor.js';
import { RequestIdInterceptor } from '../../src/common/interceptors/request-id.interceptor.js';
import { ZodValidationPipe } from '../../src/common/pipes/zod-validation.pipe.js';
import { JwtAuthGuard } from '../../src/modules/auth/guards/jwt-auth.guard.js';
import { JwtService } from '../../src/modules/auth/jwt/jwt.service.js';

export async function buildTestApp(): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    logger: false,
    trustProxy: true,
    disableRequestLogging: true,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
    abortOnError: false,
    // The Persona webhook controller verifies HMAC over the raw bytes; the
    // Fastify adapter only exposes req.rawBody when this is set on create.
    rawBody: true,
  });
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

  // Mirror main.ts: deny-by-default global auth. Tests that hit authenticated
  // routes mint a token via the test rig and pass it in Authorization.
  // Resolve dependencies from the DI container so the guard shares the same
  // JwtService + Reflector instances the rest of the app sees.
  const reflector = app.get(Reflector);
  const jwtService = app.get(JwtService);
  app.useGlobalGuards(new JwtAuthGuard(reflector, jwtService));

  await app.init();
  return app;
}
