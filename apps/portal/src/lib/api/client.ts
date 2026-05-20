/**
 * Typed HTTP client the portal uses to talk to the DankDash API.
 *
 * Design notes:
 *
 *   1. **No global singleton.** Every server action / route handler
 *      builds an `ApiClient` for the current request, with the JWT and
 *      base URL injected. This is the only safe shape inside a Next.js
 *      server runtime where a stray import-time `globalThis` cache
 *      would leak tokens across requests.
 *
 *   2. **Refresh-on-401 is the client's job, not the consumer's.** The
 *      first 401 with a refresh token available kicks off a refresh call;
 *      success retries the original request once. Second 401 in a row
 *      propagates the error to the consumer (don't loop forever).
 *
 *   3. **`AbortSignal`-aware.** Long requests cancel cleanly with the
 *      request's signal, which TanStack Query passes in automatically.
 *
 *   4. **Typed errors.** All non-2xx responses surface as `ApiError`
 *      with `status`, `code`, and the typed error envelope from the API.
 *      Consumers never see a bare `Error`.
 */
import type { LoginResponse, RefreshResponse, TokenPair } from './types.js';
import type { ErrorEnvelope } from '@dankdash/types';

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  /**
   * Called when the client refreshes successfully. The consumer is
   * expected to persist the new token pair (e.g., write into the
   * Auth.js session cookie). When omitted, refresh still works but the
   * next request rebuilds the client with a stale token — fine for a
   * one-shot server action, wrong for a long-lived UI session.
   */
  readonly onTokenRefreshed?: (tokens: TokenPair) => Promise<void> | void;
  readonly fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly query?: Record<string, string | number | boolean | undefined | null>;
  /**
   * Skip the refresh-on-401 dance for endpoints where it doesn't apply
   * (e.g. /v1/auth/refresh itself — a 401 there means the refresh token
   * is dead, not that we should rotate again).
   */
  readonly skipRefresh?: boolean;
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly envelope: ErrorEnvelope | null;

  constructor(message: string, status: number, code: string, envelope: ErrorEnvelope | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.envelope = envelope;
  }
}

export class ApiClient {
  private readonly baseUrl: string;
  private accessToken: string | undefined;
  private refreshToken: string | undefined;
  private readonly onTokenRefreshed: ((tokens: TokenPair) => Promise<void> | void) | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.baseUrl = trimTrailingSlash(options.baseUrl);
    this.accessToken = options.accessToken;
    this.refreshToken = options.refreshToken;
    this.onTokenRefreshed = options.onTokenRefreshed;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** Current access token. Test seam — production consumers shouldn't need it. */
  getAccessToken(): string | undefined {
    return this.accessToken;
  }

  async login(body: { email: string; password: string; mfaCode?: string }): Promise<LoginResponse> {
    return this.request<LoginResponse>('/v1/auth/login', {
      method: 'POST',
      body,
      skipRefresh: true,
    });
  }

  async logout(refreshToken: string): Promise<void> {
    await this.request<unknown>('/v1/auth/logout', {
      method: 'POST',
      body: { refreshToken },
      skipRefresh: true,
    });
  }

  async refresh(refreshToken: string): Promise<RefreshResponse> {
    return this.request<RefreshResponse>('/v1/auth/refresh', {
      method: 'POST',
      body: { refreshToken },
      skipRefresh: true,
    });
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const headers = this.buildHeaders(options);
    const init: RequestInit = {
      method: options.method ?? 'GET',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    };

    const response = await this.fetchImpl(url, init);

    if (response.status === 401 && !options.skipRefresh && this.refreshToken !== undefined) {
      const refreshed = await this.tryRefresh();
      if (refreshed) {
        const retryHeaders = this.buildHeaders(options);
        const retry = await this.fetchImpl(url, { ...init, headers: retryHeaders });
        return this.handleResponse<T>(retry);
      }
    }

    return this.handleResponse<T>(response);
  }

  private async tryRefresh(): Promise<boolean> {
    if (this.refreshToken === undefined) return false;
    try {
      const refreshed = await this.refresh(this.refreshToken);
      this.accessToken = refreshed.tokens.accessToken;
      this.refreshToken = refreshed.tokens.refreshToken;
      if (this.onTokenRefreshed) {
        await this.onTokenRefreshed(refreshed.tokens);
      }
      return true;
    } catch {
      // Refresh failed — let the original 401 propagate so the consumer
      // can route to /login. We clear the refresh token to avoid looping.
      this.refreshToken = undefined;
      return false;
    }
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const base = path.startsWith('/') ? `${this.baseUrl}${path}` : `${this.baseUrl}/${path}`;
    if (!query) return base;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      params.append(key, String(value));
    }
    const qs = params.toString();
    return qs.length > 0 ? `${base}?${qs}` : base;
  }

  private buildHeaders(options: RequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(options.headers ?? {}),
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (this.accessToken !== undefined) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }
    return headers;
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    if (response.status === 204) {
      // No content — surface as undefined; callers that type T as void are
      // happy, callers that expect a body get a typecheck failure where
      // they decode it.
      return undefined as T;
    }
    const text = await response.text();
    const json = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;

    if (!response.ok) {
      const envelope = extractEnvelope(json);
      const code = envelope?.error.code ?? `HTTP_${String(response.status)}`;
      const message = envelope?.error.message ?? response.statusText;
      throw new ApiError(message, response.status, code, envelope);
    }

    return json as T;
  }
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function extractEnvelope(payload: unknown): ErrorEnvelope | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const candidate = payload as Record<string, unknown>;
  const errorField = candidate['error'];
  if (typeof errorField !== 'object' || errorField === null) return null;
  const errorRecord = errorField as Record<string, unknown>;
  if (typeof errorRecord['code'] !== 'string' || typeof errorRecord['message'] !== 'string') {
    return null;
  }
  return payload as ErrorEnvelope;
}
