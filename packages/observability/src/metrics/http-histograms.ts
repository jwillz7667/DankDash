/**
 * HTTP request histograms — latency by route, method, status family.
 *
 * The bucket layout matches the SRE-canonical "100ms doubling" curve
 * (10ms, 25ms, 50ms, …, 10s) so p50/p95/p99 read directly off
 * Prometheus's `histogram_quantile`. The 10s ceiling is generous for
 * a JSON API; anything over 10s is bundled into the `+Inf` bucket and
 * shows up as a slow-request alert.
 *
 * `status_family` (2xx, 4xx, 5xx) is preferred over the full status
 * code because cardinality explodes if every 4xx variant gets its own
 * series; 5xx alerting reads the family directly, and full breakdown
 * is available via OTel spans for forensics.
 *
 * `route` is the registered route pattern (`/v1/orders/:id`), not the
 * concrete URL (`/v1/orders/01935...`). Nest's reflector exposes the
 * pattern, which is what the metric should hold — otherwise every
 * order id becomes its own metric series.
 */
import { Histogram, type Registry } from 'prom-client';

export interface HttpHistograms {
  readonly requestDurationSeconds: Histogram<'method' | 'route' | 'status_family'>;
  readonly responseSizeBytes: Histogram<'method' | 'route' | 'status_family'>;
}

const REQUEST_DURATION_BUCKETS: readonly number[] = [
  0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

const RESPONSE_SIZE_BUCKETS: readonly number[] = [
  // 1KB, 4KB, 16KB, 64KB, 256KB, 1MB, 4MB, 16MB
  1024, 4096, 16_384, 65_536, 262_144, 1_048_576, 4_194_304, 16_777_216,
];

export function createHttpHistograms(registry: Registry): HttpHistograms {
  const requestDurationSeconds = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency by route, method, and status family.',
    labelNames: ['method', 'route', 'status_family'],
    buckets: [...REQUEST_DURATION_BUCKETS],
    registers: [registry],
  });
  const responseSizeBytes = new Histogram({
    name: 'http_response_size_bytes',
    help: 'HTTP response body size in bytes by route, method, and status family.',
    labelNames: ['method', 'route', 'status_family'],
    buckets: [...RESPONSE_SIZE_BUCKETS],
    registers: [registry],
  });
  return { requestDurationSeconds, responseSizeBytes };
}

/**
 * Maps an HTTP status code to its family bucket. Anything outside the
 * 100-599 range maps to `unknown` — keep the cardinality bounded.
 */
export function statusFamily(status: number): '2xx' | '3xx' | '4xx' | '5xx' | '1xx' | 'unknown' {
  if (status >= 100 && status < 200) return '1xx';
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 300 && status < 400) return '3xx';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500 && status < 600) return '5xx';
  return 'unknown';
}
