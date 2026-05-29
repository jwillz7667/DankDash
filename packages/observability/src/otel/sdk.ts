/**
 * OpenTelemetry NodeSDK bootstrap.
 *
 * **Must be called before any other module is loaded that we want to
 * instrument** — including NestFactory, ioredis, pg, socket.io. The
 * SDK monkey-patches the imports of each instrumented module at
 * import time, so `import { initOtel } from '@dankdash/observability'`
 * must be the first executable statement in the runtime's
 * `main.ts`. Use a separate `tracing.ts` file that the entrypoint
 * imports first if convenient.
 *
 * Exporter: OTLP/HTTP. Endpoint resolves from
 * `OTEL_EXPORTER_OTLP_ENDPOINT` (declared in `packages/config/src/env.ts`).
 * When the env var is unset, the SDK still runs — spans are recorded
 * locally and dropped — so unit tests do not need a collector.
 *
 * Service identification: `service.name`, `service.version`, and
 * `deployment.environment` populate from constructor args. These
 * become resource attributes on every emitted span.
 */
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { type Instrumentation } from '@opentelemetry/instrumentation';
// `@opentelemetry/instrumentation-fastify` is deprecated upstream in favor of
// `@fastify/otel`, but the replacement requires `await app.register(plugin())`
// *before* any route is registered. NestJS's FastifyAdapter mounts routes
// during `NestFactory.create(...)` before the plugin lifecycle can interpose,
// so the official replacement does not capture per-route spans under Nest.
// Until a dedicated Nest adapter shim lands, the deprecated package continues
// to ship working hook spans.
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { SocketIoInstrumentation } from '@opentelemetry/instrumentation-socket.io';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions/incubating';

export interface OtelInitConfig {
  readonly serviceName: 'api' | 'realtime' | 'workers';
  readonly serviceVersion: string;
  readonly environment: 'development' | 'test' | 'staging' | 'production';
  /** Optional OTLP/HTTP endpoint. When undefined, spans are dropped. */
  readonly otlpEndpoint?: string;
  /**
   * Optional extra auto-instrumentations. Tests inject mocks here so
   * the SDK can boot in CI without hitting the network.
   */
  readonly extraInstrumentations?: readonly Instrumentation[];
}

export interface OtelHandle {
  readonly sdk: NodeSDK;
  readonly shutdown: () => Promise<void>;
}

/**
 * Boot the OTel SDK. Returns a handle that the caller stores for
 * SIGTERM-driven shutdown. The handle's `shutdown` flushes any
 * buffered spans before resolving — safe to await on process exit.
 */
export function initOtel(config: OtelInitConfig): OtelHandle {
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: `dankdash-${config.serviceName}`,
    [ATTR_SERVICE_VERSION]: config.serviceVersion,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.environment,
  });

  const traceExporter = new OTLPTraceExporter(
    config.otlpEndpoint !== undefined && config.otlpEndpoint.length > 0
      ? { url: `${config.otlpEndpoint.replace(/\/$/u, '')}/v1/traces` }
      : undefined,
  );

  const instrumentations: Instrumentation[] = [
    new HttpInstrumentation(),
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- see module-level note on @fastify/otel
    new FastifyInstrumentation(),
    new PgInstrumentation(),
    new IORedisInstrumentation(),
    new PinoInstrumentation(),
    new SocketIoInstrumentation(),
    ...(config.extraInstrumentations ?? []),
  ];

  const sdk = new NodeSDK({
    resource,
    traceExporter,
    instrumentations,
  });
  sdk.start();

  const shutdown = async (): Promise<void> => {
    await sdk.shutdown();
  };

  return { sdk, shutdown };
}
