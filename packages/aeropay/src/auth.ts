/**
 * OAuth 2.0 client-credentials token acquisition for Aeropay.
 *
 * Caches the access token in the injected {@link TokenCache} so every
 * worker process in the fleet shares the same token, instead of each one
 * minting its own and triggering rate-limit pushback on the upstream
 * token endpoint. The cached entry is keyed by the client id so multiple
 * Aeropay accounts (sandbox vs prod, distinct merchant sub-accounts) can
 * coexist without collisions.
 *
 * Refresh-before-expiry: tokens are stored with a TTL of `expires_in -
 * REFRESH_SKEW_SECONDS`. Reading a token after the skew window forces a
 * fresh token request, so a request that just barely missed the expiry
 * window in flight cannot land on the upstream with a stale token. The
 * skew (60s by default) absorbs clock drift between our pod and
 * Aeropay's auth server.
 *
 * Concurrency: when multiple requests race on a cache miss, we serialize
 * the token request behind an in-flight promise. The cache write that
 * follows is idempotent so the lost-race side also returns the freshly
 * minted token without re-fetching.
 */
import { ExternalServiceError } from '@dankdash/types';
import { type HttpClient } from './http.js';
import { TokenResponseSchema } from './schemas.js';
import { type TokenCache } from './token-cache.js';

const SERVICE = 'aeropay';
const TOKEN_CACHE_KEY_PREFIX = 'aeropay:token:';
const DEFAULT_REFRESH_SKEW_SECONDS = 60;
const MIN_USEFUL_TTL_SECONDS = 30;

export interface AeropayAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly apiBaseUrl: string;
  readonly http: HttpClient;
  readonly cache: TokenCache;
  /** Defaults to 60s — set lower in tests when needed. */
  readonly refreshSkewSeconds?: number;
}

interface CachedTokenPayload {
  readonly accessToken: string;
  readonly tokenType: string;
}

export class AeropayAuth {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly apiBaseUrl: string;
  private readonly http: HttpClient;
  private readonly cache: TokenCache;
  private readonly refreshSkewSeconds: number;
  private inFlight: Promise<CachedTokenPayload> | null = null;

  constructor(config: AeropayAuthConfig) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.apiBaseUrl = config.apiBaseUrl.replace(/\/+$/, '');
    this.http = config.http;
    this.cache = config.cache;
    this.refreshSkewSeconds = config.refreshSkewSeconds ?? DEFAULT_REFRESH_SKEW_SECONDS;
  }

  async getAuthorizationHeader(): Promise<string> {
    const token = await this.getToken();
    return `${token.tokenType} ${token.accessToken}`;
  }

  /**
   * Forces a token refresh — used when a 401 surfaces from the API client
   * to recover from a token revoked mid-TTL (e.g. credentials rotated in
   * the Aeropay dashboard).
   */
  async invalidate(): Promise<void> {
    await this.cache.del(this.cacheKey());
  }

  private async getToken(): Promise<CachedTokenPayload> {
    const cacheKey = this.cacheKey();
    const cached = await this.cache.get(cacheKey);
    if (cached !== null) {
      const parsed = safeParseCached(cached);
      if (parsed !== null) return parsed;
      // Corrupt cache entry — drop and re-fetch. Surfacing as a hard
      // failure would risk wedging the whole API on a single bad string.
      await this.cache.del(cacheKey);
    }

    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.fetchAndCache(cacheKey).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetchAndCache(cacheKey: string): Promise<CachedTokenPayload> {
    const url = `${this.apiBaseUrl}/oauth/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    }).toString();

    const resp = await this.http.send({
      method: 'POST',
      url,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    });

    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      throw new ExternalServiceError(
        SERVICE,
        `OAuth token request returned ${String(resp.statusCode)}`,
        { status: resp.statusCode },
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(resp.body);
    } catch (err) {
      throw new ExternalServiceError(SERVICE, 'OAuth response was not valid JSON', {}, err);
    }

    const parsed = TokenResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new ExternalServiceError(SERVICE, 'OAuth response failed schema validation', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    const ttlSeconds = Math.max(
      MIN_USEFUL_TTL_SECONDS,
      parsed.data.expires_in - this.refreshSkewSeconds,
    );
    const payload: CachedTokenPayload = {
      accessToken: parsed.data.access_token,
      tokenType: parsed.data.token_type,
    };
    await this.cache.set(cacheKey, JSON.stringify(payload), ttlSeconds);
    return payload;
  }

  private cacheKey(): string {
    return `${TOKEN_CACHE_KEY_PREFIX}${this.clientId}`;
  }
}

function safeParseCached(serialized: string): CachedTokenPayload | null {
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'accessToken' in parsed &&
      'tokenType' in parsed &&
      typeof (parsed as { accessToken: unknown }).accessToken === 'string' &&
      typeof (parsed as { tokenType: unknown }).tokenType === 'string'
    ) {
      const obj = parsed as { accessToken: string; tokenType: string };
      return { accessToken: obj.accessToken, tokenType: obj.tokenType };
    }
    return null;
  } catch {
    return null;
  }
}
