/**
 * OpenTelemetry bootstrap for apps/workers.
 *
 * **Imported FIRST in `main.ts` — before pg, ioredis, fastify, or
 * undici are pulled in transitively via repositories / Aeropay / the
 * metrics HTTP listener.** OTel's auto-instrumentations register
 * `require` hooks that monkey-patch each module's exports at load
 * time; if any of those are loaded before `initOtel`, the patches
 * miss and the spans go dark.
 *
 * Service identifier is `dankdash-workers`. The OTLP/HTTP endpoint
 * resolves from `OTEL_EXPORTER_OTLP_ENDPOINT` in `process.env`;
 * unset is fine for local dev (spans drop silently). The handle is
 * wired into the SIGTERM path in `main.ts` so the buffered batch
 * flushes before Railway sends SIGKILL.
 */
import { initOtel, type OtelHandle } from '@dankdash/observability';

const serviceVersion = process.env['SERVICE_VERSION'] ?? '0.0.0';
const environment = ((): 'development' | 'test' | 'staging' | 'production' => {
  const value = process.env['NODE_ENV'];
  if (value === 'test' || value === 'staging' || value === 'production') return value;
  return 'development';
})();
const otlpEndpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];

export const workersOtelHandle: OtelHandle = initOtel({
  serviceName: 'workers',
  serviceVersion,
  environment,
  ...(otlpEndpoint !== undefined && otlpEndpoint.length > 0 ? { otlpEndpoint } : {}),
});
