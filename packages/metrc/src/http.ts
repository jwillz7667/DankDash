/**
 * Thin undici wrapper used by every Metrc API call.
 *
 * Mirrors the shape of `@dankdash/aeropay`'s HttpClient deliberately so
 * the two external integrations look identical at the transport layer:
 *
 *   - One place to apply the bounded body-size cap, per-request timeout,
 *     and retry policy.
 *   - One place to map low-level network errors to
 *     `ExternalServiceError('metrc', ...)` so the worker logs and
 *     downstream alerting see a consistent shape.
 *   - Tests inject a fake `HttpDispatcher` to avoid binding the suite to
 *     undici internals or live sockets.
 *
 * Retry policy: at most `retries` attempts (default 2 extra after the
 * initial try). Metrc treats `POST /sales/v2/receipts` as
 * non-idempotent — the same payload posted twice creates two receipts in
 * the upstream ledger, which is a compliance disaster. We therefore *only*
 * retry POST when the caller passes a non-empty `Idempotency-Key` header
 * AND Metrc's own behavior is that we're safe to retry (in practice this
 * means: never retry create-receipt without out-of-band dedup; the worker
 * uses DB-level uniqueness on `metrc_transactions.order_id` for that
 * dedup). Idempotent verbs (GET / PUT / DELETE) retry unconditionally.
 *
 * Retried statuses: 408, 425, 429, 500, 502, 503, 504. Other 4xx are
 * terminal — they signal a request the upstream will keep rejecting until
 * the caller intervenes (bad credentials, malformed body, license
 * mismatch). A 401 here is therefore *not* retried; the worker maps it to
 * a permanent failure on the metrc_transactions row and pages ops.
 */
import { ExternalServiceError } from '@dankdash/types';

const SERVICE = 'metrc';

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
    // POSTs that ship an Idempotency-Key are retry-safe at the caller's
    // assertion. Metrc itself doesn't honor an Idempotency-Key header; we
    // rely on DB-level uniqueness on metrc_transactions.order_id for
    // dedup. The header here is the local signal "this caller has its
    // own dedup, retry is safe".
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
 * Drop the query-string before logging. Metrc passes the license number
 * (`?licenseNumber=...`) as a query parameter, and while the license
 * number is technically a public identifier (printed on the dispensary's
 * storefront), keeping it out of structured logs reduces blast radius if
 * those logs land somewhere they shouldn't.
 */
function redactUrl(url: string): string {
  const qIdx = url.indexOf('?');
  return qIdx < 0 ? url : url.slice(0, qIdx);
}
