/**
 * AeropayAuth — token acquisition, caching, refresh, and concurrent fetch.
 *
 * Every test wires a HttpClient against a fake dispatcher and a
 * MemoryTokenCache, so we can assert call counts, cache contents, and
 * the in-flight serialization behavior without any real network or
 * Redis. The cache key shape is asserted in one place so a rename
 * doesn't silently change the cross-process sharing contract.
 */
import { ExternalServiceError } from '@dankdash/types';
import { describe, expect, it, vi } from 'vitest';
import { AeropayAuth } from '../src/auth.js';
import { HttpClient, type HttpDispatcher } from '../src/http.js';
import { MemoryTokenCache } from '../src/token-cache.js';

function makeAuth(opts: {
  readonly dispatcher: HttpDispatcher;
  readonly cache?: MemoryTokenCache;
  readonly refreshSkewSeconds?: number;
  readonly clientId?: string;
}): { auth: AeropayAuth; cache: MemoryTokenCache } {
  const cache = opts.cache ?? new MemoryTokenCache();
  const auth = new AeropayAuth({
    clientId: opts.clientId ?? 'client-test',
    clientSecret: 'shh-secret',
    apiBaseUrl: 'https://api.aeropay.example/',
    http: new HttpClient({
      dispatcher: opts.dispatcher,
      retries: 0,
      sleep: () => Promise.resolve(),
    }),
    cache,
    ...(opts.refreshSkewSeconds !== undefined
      ? { refreshSkewSeconds: opts.refreshSkewSeconds }
      : {}),
  });
  return { auth, cache };
}

function tokenResponse(body: Record<string, unknown> = {}): Awaited<ReturnType<HttpDispatcher>> {
  return {
    statusCode: 200,
    headers: {},
    body: JSON.stringify({
      access_token: 'a-fresh-token',
      token_type: 'Bearer',
      expires_in: 3600,
      ...body,
    }),
  };
}

describe('AeropayAuth', () => {
  it('fetches a fresh token, caches it, and returns the Authorization header', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(tokenResponse());
    const { auth, cache } = makeAuth({ dispatcher });
    const header = await auth.getAuthorizationHeader();
    expect(header).toBe('Bearer a-fresh-token');
    expect(dispatcher).toHaveBeenCalledTimes(1);
    const cached = await cache.get('aeropay:token:client-test');
    expect(cached).not.toBeNull();
    expect(JSON.parse(cached!)).toEqual({
      accessToken: 'a-fresh-token',
      tokenType: 'Bearer',
    });
  });

  it('hits the token endpoint with form-encoded client_credentials and trims trailing slash', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(tokenResponse());
    const { auth } = makeAuth({ dispatcher });
    await auth.getAuthorizationHeader();
    const [req] = dispatcher.mock.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.aeropay.example/oauth/token');
    expect(req.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(req.body).toContain('grant_type=client_credentials');
    expect(req.body).toContain('client_id=client-test');
    expect(req.body).toContain('client_secret=shh-secret');
  });

  it('reuses the cached token on the second call (no extra dispatcher hit)', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(tokenResponse());
    const { auth } = makeAuth({ dispatcher });
    await auth.getAuthorizationHeader();
    await auth.getAuthorizationHeader();
    expect(dispatcher).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent token requests behind a single in-flight promise', async () => {
    let release: ((value: Awaited<ReturnType<HttpDispatcher>>) => void) | undefined;
    const dispatcher = vi.fn<HttpDispatcher>().mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const { auth } = makeAuth({ dispatcher });
    const p1 = auth.getAuthorizationHeader();
    const p2 = auth.getAuthorizationHeader();
    release!(tokenResponse());
    const [h1, h2] = await Promise.all([p1, p2]);
    expect(h1).toBe('Bearer a-fresh-token');
    expect(h2).toBe('Bearer a-fresh-token');
    expect(dispatcher).toHaveBeenCalledTimes(1);
  });

  it('refreshes the token after TTL minus skew elapses', async () => {
    let now = 1_700_000_000_000;
    const cache = new MemoryTokenCache(() => now);
    const dispatcher = vi
      .fn<HttpDispatcher>()
      .mockResolvedValueOnce(tokenResponse({ access_token: 'first', expires_in: 100 }))
      .mockResolvedValueOnce(tokenResponse({ access_token: 'second', expires_in: 100 }));
    const { auth } = makeAuth({ dispatcher, cache, refreshSkewSeconds: 10 });

    const h1 = await auth.getAuthorizationHeader();
    expect(h1).toBe('Bearer first');

    // (100 - 10) = 90s TTL — advance 91s and we should fetch again.
    now += 91_000;
    const h2 = await auth.getAuthorizationHeader();
    expect(h2).toBe('Bearer second');
    expect(dispatcher).toHaveBeenCalledTimes(2);
  });

  it('clamps the cache TTL to the minimum useful value when the upstream TTL is tiny', async () => {
    let now = 0;
    const cache = new MemoryTokenCache(() => now);
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(tokenResponse({ expires_in: 5 }));
    const { auth } = makeAuth({ dispatcher, cache, refreshSkewSeconds: 60 });
    await auth.getAuthorizationHeader();
    // Skew (60) > expires_in (5) would yield -55s; clamped to the
    // 30-second floor, so a cache read 29s later still hits.
    now += 29_000;
    expect(await cache.get('aeropay:token:client-test')).not.toBeNull();
  });

  it('drops a corrupt cache entry and re-fetches', async () => {
    const cache = new MemoryTokenCache();
    await cache.set('aeropay:token:client-test', 'not-json', 3600);
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(tokenResponse());
    const { auth } = makeAuth({ dispatcher, cache });
    const header = await auth.getAuthorizationHeader();
    expect(header).toBe('Bearer a-fresh-token');
    expect(dispatcher).toHaveBeenCalledTimes(1);
  });

  it('drops a cache entry that parses but has the wrong shape', async () => {
    const cache = new MemoryTokenCache();
    await cache.set('aeropay:token:client-test', JSON.stringify({ foo: 'bar' }), 3600);
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(tokenResponse());
    const { auth } = makeAuth({ dispatcher, cache });
    await auth.getAuthorizationHeader();
    expect(dispatcher).toHaveBeenCalledTimes(1);
  });

  it('drops a cache entry whose tokenType is not a string', async () => {
    const cache = new MemoryTokenCache();
    await cache.set(
      'aeropay:token:client-test',
      JSON.stringify({ accessToken: 'x', tokenType: 123 }),
      3600,
    );
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(tokenResponse());
    const { auth } = makeAuth({ dispatcher, cache });
    await auth.getAuthorizationHeader();
    expect(dispatcher).toHaveBeenCalledTimes(1);
  });

  it('invalidate() forces a fresh token on the next request', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(tokenResponse());
    const { auth, cache } = makeAuth({ dispatcher });
    await auth.getAuthorizationHeader();
    expect(await cache.get('aeropay:token:client-test')).not.toBeNull();
    await auth.invalidate();
    expect(await cache.get('aeropay:token:client-test')).toBeNull();
    await auth.getAuthorizationHeader();
    expect(dispatcher).toHaveBeenCalledTimes(2);
  });

  it('throws ExternalServiceError on a non-2xx token response', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue({
      statusCode: 401,
      headers: {},
      body: 'unauthorized',
    });
    const { auth } = makeAuth({ dispatcher });
    await expect(auth.getAuthorizationHeader()).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it('throws ExternalServiceError when the token response is not JSON', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: 'not-json-here',
    });
    const { auth } = makeAuth({ dispatcher });
    await expect(auth.getAuthorizationHeader()).rejects.toThrow(/valid JSON/);
  });

  it('throws ExternalServiceError when the token response fails schema validation', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: JSON.stringify({ access_token: 'x' }), // missing token_type, expires_in
    });
    const { auth } = makeAuth({ dispatcher });
    await expect(auth.getAuthorizationHeader()).rejects.toThrow(/schema validation/);
  });

  it('uses the default 60s skew when not overridden', async () => {
    const dispatcher = vi
      .fn<HttpDispatcher>()
      .mockResolvedValue(tokenResponse({ expires_in: 120 }));
    let now = 0;
    const cache = new MemoryTokenCache(() => now);
    const { auth } = makeAuth({ dispatcher, cache });
    await auth.getAuthorizationHeader();
    // 120 - 60 = 60s TTL. At 59s the cached entry must still be there.
    now += 59_000;
    expect(await cache.get('aeropay:token:client-test')).not.toBeNull();
    now += 2_000;
    expect(await cache.get('aeropay:token:client-test')).toBeNull();
  });
});
