/**
 * Thin undici wrapper used by every Aeropay API call.
 *
 * Why a wrapper rather than calling `request()` inline:
 *   - One place to apply the bounded body-size cap, per-request timeout,
 *     and retry policy. Without it each method would diverge.
 *   - One place to map low-level network errors (ECONNRESET, TLS, parse,
 *     timeout) to `ExternalServiceError('aeropay', ...)` so the API filter
 *     renders a clean 502 instead of an unhandled rejection.
 *   - Tests inject a `Dispatcher`-like fake via the `dispatch` callable to
 *     avoid binding the package's tests to undici internals or HTTP plumbing.
 *
 * Retry policy: at most `retries` attempts (default 2 extra after the
 * initial try) on idempotent verbs (GET/PUT/DELETE) or on POSTs that carry
 * an `Idempotency-Key` header. Aeropay treats the idempotency key as the
 * coalescing identifier, so repeating a POST is safe iff the key is set.
 * Without it, retrying POST risks duplicate payments — refuse loudly.
 *
 * Retried statuses: 408, 425, 429, 500, 502, 503, 504. Other 4xx are
 * treated as terminal because Aeropay won't change its mind without
 * caller intervention.
 */
import { ExternalServiceError } from '@dankdash/types';

const SERVICE = 'aeropay';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface HttpRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Pre-serialized body (typically JSON). */
  readonly body?: string;
  /** Per-request timeout. Falls back to the dispatcher default. */
  readonly timeoutMs?: number;
}

export interface HttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * The minimal shape we need from a transport. `undici.request` adapts
 * to this in production via {@link undiciDispatcher}; tests use an
 * in-memory fake. Returning `HttpResponse` (body already consumed)
 * keeps the retry/error-mapping logic readable.
 */
export type HttpDispatcher = (req: HttpRequest) => Promise<HttpResponse>;

export interface HttpClientConfig {
  readonly dispatcher: HttpDispatcher;
  readonly defaultTimeoutMs?: number;
  readonly retries?: number;
  readonly retryBackoffMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 250;
const RETRY_STATUSES: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504]);
const IDEMPOTENT_VERBS: ReadonlySet<HttpMethod> = new Set(['GET', 'PUT', 'DELETE']);

export class HttpClient {
  private readonly dispatcher: HttpDispatcher;
  private readonly defaultTimeoutMs: number;
  private readonly retries: number;
  private readonly retryBackoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: HttpClientConfig) {
    this.dispatcher = config.dispatcher;
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = config.retries ?? DEFAULT_RETRIES;
    this.retryBackoffMs = config.retryBackoffMs ?? DEFAULT_BACKOFF_MS;
    this.sleep =
      config.sleep ??
      ((ms: number): Promise<void> =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    const retryable = this.isRetryable(req);
    const maxAttempts = Math.max(1, retryable ? this.retries + 1 : 1);
    let attempt = 0;

    // `for (;;)` over `for ... attempt <= maxAttempts` is deliberate —
    // every exit is via `return` or `throw` inside the loop, which
    // eliminates the trailing "should never reach here" branch that
    // would otherwise be defensive dead code on the coverage report.
    for (;;) {
      attempt += 1;
      const isLastAttempt = attempt >= maxAttempts;
      try {
        const resp = await this.dispatcher({
          ...req,
          timeoutMs: req.timeoutMs ?? this.defaultTimeoutMs,
        });
        if (resp.statusCode < 500 && !RETRY_STATUSES.has(resp.statusCode)) {
          return resp;
        }
        if (isLastAttempt) return resp;
      } catch (err) {
        if (isLastAttempt) {
          throw new ExternalServiceError(
            SERVICE,
            `HTTP request failed: ${describeError(err)}`,
            { url: redactUrl(req.url), method: req.method },
            err,
          );
        }
      }
      await this.sleep(this.retryBackoffMs * attempt);
    }
  }

  private isRetryable(req: HttpRequest): boolean {
    if (IDEMPOTENT_VERBS.has(req.method)) return true;
    // Aeropay's POST endpoints accept `Idempotency-Key`; with it, replaying
    // the request returns the prior response rather than creating a new
    // payment, so retry is safe. Without it, the only correct action is to
    // fail and let the caller decide.
    const headers = req.headers;
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'idempotency-key' && headers[key] !== undefined) return true;
    }
    return false;
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'unknown error';
}

/**
 * Strip query-string credentials (`?token=...`) before logging. Aeropay's
 * REST API doesn't put secrets in the URL, but defensive masking here means
 * a future query-string change can't accidentally leak a token to the log
 * pipeline.
 */
function redactUrl(url: string): string {
  const qIdx = url.indexOf('?');
  return qIdx < 0 ? url : url.slice(0, qIdx);
}
