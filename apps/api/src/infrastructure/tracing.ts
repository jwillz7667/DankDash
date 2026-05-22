/**
 * OpenTelemetry bootstrap for apps/api.
 *
 * **This module is imported FIRST in `main.ts` — before NestFactory,
 * before `AppModule`.** OTel's auto-instrumentations register `require`
 * hooks that monkey-patch each instrumented module's exports at import
 * time. If `pg` / `ioredis` / `fastify` / `socket.io` are loaded before
 * `initOtel`, the patches don't apply and we get blank spans.
 *
 * The SDK is created lazily through `loadEnv`: in test runs the
 * envconfig is partial and `OTEL_EXPORTER_OTLP_ENDPOINT` is unset,
 * which is fine — `initOtel` still constructs the SDK so context
 * propagation works for the integration tests, but the OTLP exporter
 * gets a "no endpoint" config and drops spans on flush.
 *
 * The shutdown handle is registered globally via `globalThis` so
 * `main.ts` can pick it up and wire it into the SIGTERM path without
 * cycling through the module again.
 */
import { loadEnv } from '@dankdash/config';
import { initOtel, type OtelHandle } from '@dankdash/observability';

const env = loadEnv({
  allowPartial: process.env['ALLOW_PARTIAL_ENV'] === '1',
});

const serviceVersion = process.env['SERVICE_VERSION'] ?? '0.0.0';

export const apiOtelHandle: OtelHandle = initOtel({
  serviceName: 'api',
  serviceVersion,
  environment: env.NODE_ENV,
  ...(env.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined
    ? { otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT }
    : {}),
});
