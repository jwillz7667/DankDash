/**
 * Process-singleton Prometheus registry.
 *
 * Every runtime calls `getRegistry()` to register histograms /
 * counters / gauges, and exposes the registry's text format at
 * `/metrics`. The registry is a module-scoped singleton because
 * `prom-client`'s default registry is also process-global, and
 * shipping two registries would double-count every metric.
 *
 * Default labels (`service`, `environment`) are applied at boot via
 * `configureRegistry`. Calling `configureRegistry` more than once
 * overwrites the previous labels — useful in tests, harmless in
 * production where the labels never change after boot.
 *
 * `collectDefaultMetrics` adds process-level gauges (RSS, GC pause
 * histogram, event-loop lag, active handles). These are always-on;
 * the cost is ~50 µs per scrape per process.
 */
import { Registry, collectDefaultMetrics } from 'prom-client';

export interface RegistryConfig {
  readonly service: 'api' | 'realtime' | 'workers';
  readonly environment: 'development' | 'test' | 'staging' | 'production';
  /** Defaults to `true`. Tests disable this to avoid timer leaks. */
  readonly collectDefault?: boolean;
}

let registry: Registry | undefined;

/**
 * One-time setup, called from each runtime's bootstrap. Idempotent on
 * a per-process basis — calling again replaces the registry, which is
 * what tests want so isolation is clean between specs.
 */
export function configureRegistry(config: RegistryConfig): Registry {
  const reg = new Registry();
  reg.setDefaultLabels({
    service: config.service,
    environment: config.environment,
  });
  if (config.collectDefault !== false) {
    collectDefaultMetrics({ register: reg });
  }
  registry = reg;
  return reg;
}

/**
 * Returns the configured registry. Throws if `configureRegistry` has
 * not been called — that is a programmer error (a metric was
 * registered before bootstrap ran), not a runtime condition we want
 * to fall through silently.
 */
export function getRegistry(): Registry {
  if (registry === undefined) {
    throw new RegistryNotConfiguredError();
  }
  return registry;
}

/**
 * Resets the singleton. Tests only — production code must not call
 * this; resetting mid-flight would orphan every histogram/counter
 * the registered metric modules hold.
 */
export function resetRegistry(): void {
  registry = undefined;
}

export class RegistryNotConfiguredError extends Error {
  public override readonly name = 'RegistryNotConfiguredError';
  constructor() {
    super('observability: getRegistry() called before configureRegistry()');
  }
}
