/**
 * Graceful SIGTERM shutdown that flushes the OTel SDK before exit.
 *
 * Railway sends SIGTERM with a 30s grace window before SIGKILL. The
 * SDK's default exporter batches spans on a 5s interval; without a
 * flush on SIGTERM, the last batch is dropped. This helper wires the
 * shutdown into Node's signal handlers and guarantees flush
 * completes before `process.exit` is called.
 *
 * The Sentry close is included alongside OTel because both share the
 * same "flush before exit" requirement; combining them avoids two
 * SIGTERM handlers racing.
 */
import type { OtelHandle } from './sdk.js';

export interface ShutdownConfig {
  readonly otel: OtelHandle;
  readonly sentryClose?: (timeoutMs: number) => Promise<boolean>;
  /** Defaults to 10_000 ms — well inside Railway's 30s SIGTERM window. */
  readonly drainTimeoutMs?: number;
  /** Test injection; defaults to process.on. */
  readonly registerSignal?: (signal: NodeJS.Signals, handler: () => void) => void;
  /** Test injection; defaults to process.exit. */
  readonly exit?: (code: number) => void;
}

export function registerGracefulShutdown(config: ShutdownConfig): void {
  const drainTimeoutMs = config.drainTimeoutMs ?? 10_000;
  const register = config.registerSignal ?? ((sig, h) => process.on(sig, h));
  const exit = config.exit ?? ((code) => process.exit(code));

  let shuttingDown = false;
  const handle = (signal: NodeJS.Signals) => () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async (): Promise<void> => {
      try {
        await Promise.all([
          config.otel.shutdown(),
          config.sentryClose !== undefined ? config.sentryClose(drainTimeoutMs) : Promise.resolve(),
        ]);
      } finally {
        exit(signal === 'SIGTERM' ? 0 : 1);
      }
    })();
  };
  register('SIGTERM', handle('SIGTERM'));
  register('SIGINT', handle('SIGINT'));
}
