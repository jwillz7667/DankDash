/**
 * OpenTelemetry bootstrap for apps/realtime.
 *
 * **Imported FIRST in `main.ts` — before Fastify, Socket.io, ioredis, or
 * pg are pulled in transitively.** OTel's auto-instrumentations register
 * `require` hooks that monkey-patch each module's exports at load time;
 * if `socket.io` or `ioredis` is imported before `initOtel`, the patches
 * miss and the socket / Redis spans go dark.
 *
 * Service identifier is `dankdash-realtime` (set inside `initOtel`).
 * The OTLP/HTTP endpoint resolves from `OTEL_EXPORTER_OTLP_ENDPOINT` in
 * `process.env` — unset is fine for local dev (spans drop silently).
 * The handle exported here is wired into the SIGTERM path in `main.ts`
 * so the buffered batch flushes before Railway sends SIGKILL.
 */
import { initOtel, type OtelHandle } from '@dankdash/observability';

const serviceVersion = process.env['SERVICE_VERSION'] ?? '0.0.0';
const environment = ((): 'development' | 'test' | 'staging' | 'production' => {
  const value = process.env['NODE_ENV'];
  if (value === 'test' || value === 'staging' || value === 'production') return value;
  return 'development';
})();
const otlpEndpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];

export const realtimeOtelHandle: OtelHandle = initOtel({
  serviceName: 'realtime',
  serviceVersion,
  environment,
  ...(otlpEndpoint !== undefined && otlpEndpoint.length > 0 ? { otlpEndpoint } : {}),
});
