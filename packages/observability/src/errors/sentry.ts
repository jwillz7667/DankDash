/**
 * Sentry initialization for Node runtimes.
 *
 * Init is env-gated: when `SENTRY_DSN` is unset, `initSentry` returns
 * a no-op handle so test runs and local dev do not depend on a
 * Sentry project. When set, the SDK starts with the standard Node
 * integrations and a sampling rate suitable for the runtime
 * (`tracesSampleRate` low — we already have OTel traces; Sentry only
 * needs the error path).
 *
 * The PII-scrubber hook reads from ALS to attach `requestId` /
 * `userId` / `dispensaryId` to every captured event. The hook
 * intentionally never reads the request body or response body —
 * those carry redacted log surfaces but Sentry events should not
 * include them at all (Sentry's own retention policy differs from
 * ours).
 */
import * as Sentry from '@sentry/node';
import { getRequestContext } from '../context/als.js';

export interface SentryInitConfig {
  readonly dsn?: string;
  readonly serviceName: 'api' | 'realtime' | 'workers';
  readonly serviceVersion: string;
  readonly environment: 'development' | 'test' | 'staging' | 'production';
  /** Defaults to 0.0 — OTel handles traces; Sentry is errors-only. */
  readonly tracesSampleRate?: number;
}

export interface SentryHandle {
  readonly captureException: (err: unknown, extra?: Record<string, unknown>) => void;
  readonly close: (timeoutMs: number) => Promise<boolean>;
  readonly initialized: boolean;
}

const NOOP_HANDLE: SentryHandle = {
  captureException: (_err: unknown, _extra?: Record<string, unknown>): void => {
    void _err;
    void _extra;
  },
  close: (_timeoutMs: number): Promise<boolean> => {
    void _timeoutMs;
    return Promise.resolve(true);
  },
  initialized: false,
};

export function initSentry(config: SentryInitConfig): SentryHandle {
  if (config.dsn === undefined || config.dsn.length === 0) {
    return NOOP_HANDLE;
  }

  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    release: `dankdash-${config.serviceName}@${config.serviceVersion}`,
    serverName: `dankdash-${config.serviceName}`,
    tracesSampleRate: config.tracesSampleRate ?? 0,
    beforeSend(event) {
      const ctx = getRequestContext();
      if (ctx === undefined) return event;
      const tags = { ...(event.tags ?? {}) };
      tags['request_id'] = ctx.requestId;
      if (ctx.traceId !== undefined) tags['trace_id'] = ctx.traceId;
      if (ctx.userId !== undefined) tags['user_id'] = ctx.userId;
      if (ctx.dispensaryId !== undefined) tags['dispensary_id'] = ctx.dispensaryId;
      return { ...event, tags };
    },
  });

  return {
    captureException: (err, extra) => {
      Sentry.captureException(err, extra !== undefined ? { extra } : undefined);
    },
    close: (timeoutMs) => Sentry.close(timeoutMs),
    initialized: true,
  };
}
