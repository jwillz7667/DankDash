import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from './client.js';
import type { TokenPair } from './types.js';

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
}

function buildResponse(
  status: number,
  body: unknown,
  init?: { readonly statusText?: string },
): Response {
  // Response constructor forbids bodies for 204/205/304. Pass null in that case.
  const allowsBody = ![204, 205, 304].includes(status);
  const payload = allowsBody ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
  return new Response(payload, {
    status,
    statusText: init?.statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}

function captureRequest(input: RequestInfo | URL, init?: RequestInit): CapturedRequest {
  const url = typeof input === 'string' ? input : input.toString();
  const headers: Record<string, string> = {};
  const rawHeaders = init?.headers;
  if (rawHeaders instanceof Headers) {
    rawHeaders.forEach((value, key) => {
      headers[key] = value;
    });
  } else if (rawHeaders) {
    Object.assign(headers, rawHeaders as Record<string, string>);
  }
  const body = typeof init?.body === 'string' ? init.body : null;
  return { url, method: init?.method ?? 'GET', headers, body };
}

describe('ApiClient', () => {
  let captured: CapturedRequest[];

  beforeEach(() => {
    captured = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GETs the supplied path against the configured base URL with the bearer token', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push(captureRequest(input, init));
      return buildResponse(200, { ok: true });
    });

    const client = new ApiClient({
      baseUrl: 'https://api.test/',
      accessToken: 'access-1',
      fetchImpl,
    });
    const result = await client.request<{ ok: boolean }>('/v1/me');

    expect(result).toEqual({ ok: true });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe('https://api.test/v1/me');
    expect(captured[0]?.method).toBe('GET');
    expect(captured[0]?.headers['Authorization']).toBe('Bearer access-1');
    expect(captured[0]?.headers['Accept']).toBe('application/json');
  });

  it('strips a trailing slash from the base URL and joins paths correctly', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push(captureRequest(input, init));
      return buildResponse(204, '');
    });
    const client = new ApiClient({ baseUrl: 'https://api.test/', fetchImpl });
    await client.request<void>('/v1/things');
    expect(captured[0]?.url).toBe('https://api.test/v1/things');
  });

  it('serializes the body as JSON and sets Content-Type when present', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push(captureRequest(input, init));
      return buildResponse(201, { id: 'x' });
    });
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl });
    await client.request<{ id: string }>('/v1/things', {
      method: 'POST',
      body: { name: 'foo' },
    });
    expect(captured[0]?.headers['Content-Type']).toBe('application/json');
    expect(captured[0]?.body).toBe('{"name":"foo"}');
  });

  it('appends query parameters and skips undefined / null values', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push(captureRequest(input, init));
      return buildResponse(200, []);
    });
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl });
    await client.request('/v1/list', {
      query: { page: 2, limit: 50, cursor: undefined, since: null },
    });
    expect(captured[0]?.url).toBe('https://api.test/v1/list?page=2&limit=50');
  });

  it('returns undefined for 204 No Content', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl });
    const result = await client.request<undefined>('/v1/del', { method: 'DELETE' });
    expect(result).toBeUndefined();
  });

  it('throws ApiError with the envelope on a non-2xx response', async () => {
    const envelope = {
      error: {
        code: 'VALIDATION_FAILED',
        message: 'email is required',
        details: { field: 'email' },
      },
    };
    const fetchImpl = vi.fn(async () => buildResponse(422, envelope));
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl });

    await expect(client.request('/v1/things', { method: 'POST', body: {} })).rejects.toMatchObject({
      name: 'ApiError',
      status: 422,
      code: 'VALIDATION_FAILED',
      message: 'email is required',
    });
  });

  it('falls back to an HTTP_<status> code when the body has no envelope', async () => {
    const fetchImpl = vi.fn(async () =>
      buildResponse(500, { unexpected: 'shape' }, { statusText: 'Server Down' }),
    );
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl });
    let err: unknown;
    try {
      await client.request('/v1/x');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(500);
    expect(apiErr.code).toBe('HTTP_500');
    expect(apiErr.envelope).toBeNull();
  });

  it('refreshes on a 401 and retries the original request exactly once', async () => {
    const newTokens: TokenPair = {
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      accessTokenExpiresAt: '2030-01-01T00:00:00Z',
      refreshTokenExpiresAt: '2030-01-14T00:00:00Z',
      tokenType: 'Bearer',
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = captureRequest(input, init);
      captured.push(req);
      if (req.url.endsWith('/v1/auth/refresh')) {
        return buildResponse(200, { tokens: newTokens });
      }
      if (req.headers['Authorization'] === 'Bearer access-1') {
        return buildResponse(401, {
          error: { code: 'TOKEN_EXPIRED', message: 'expired', details: {} },
        });
      }
      return buildResponse(200, { ok: true });
    });

    const onTokenRefreshed = vi.fn();
    const client = new ApiClient({
      baseUrl: 'https://api.test',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      onTokenRefreshed,
      fetchImpl,
    });

    const result = await client.request<{ ok: boolean }>('/v1/me');

    expect(result).toEqual({ ok: true });
    expect(captured.map((c) => c.url)).toEqual([
      'https://api.test/v1/me',
      'https://api.test/v1/auth/refresh',
      'https://api.test/v1/me',
    ]);
    expect(captured[2]?.headers['Authorization']).toBe('Bearer access-2');
    expect(onTokenRefreshed).toHaveBeenCalledWith(newTokens);
    expect(client.getAccessToken()).toBe('access-2');
  });

  it('does not loop forever if the second leg also returns 401', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = captureRequest(input, init);
      captured.push(req);
      if (req.url.endsWith('/v1/auth/refresh')) {
        return buildResponse(200, {
          tokens: {
            accessToken: 'access-2',
            refreshToken: 'refresh-2',
            accessTokenExpiresAt: '2030-01-01T00:00:00Z',
            refreshTokenExpiresAt: '2030-01-14T00:00:00Z',
            tokenType: 'Bearer' as const,
          },
        });
      }
      return buildResponse(401, {
        error: { code: 'TOKEN_EXPIRED', message: 'expired', details: {} },
      });
    });

    const client = new ApiClient({
      baseUrl: 'https://api.test',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      fetchImpl,
    });

    await expect(client.request('/v1/me')).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
    });
    // Two 401s + one refresh = 3 total. No third retry.
    expect(captured).toHaveLength(3);
  });

  it('propagates the 401 when refresh itself fails', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = captureRequest(input, init);
      captured.push(req);
      if (req.url.endsWith('/v1/auth/refresh')) {
        return buildResponse(401, {
          error: { code: 'TOKEN_INVALID', message: 'refresh token dead', details: {} },
        });
      }
      return buildResponse(401, {
        error: { code: 'TOKEN_EXPIRED', message: 'expired', details: {} },
      });
    });

    const client = new ApiClient({
      baseUrl: 'https://api.test',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      fetchImpl,
    });

    await expect(client.request('/v1/me')).rejects.toBeInstanceOf(ApiError);
    // Exactly 2 calls: original 401 + failed refresh.
    expect(captured).toHaveLength(2);
  });

  it('does not attempt refresh when skipRefresh is set (login/refresh paths)', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push(captureRequest(input, init));
      return buildResponse(401, {
        error: { code: 'INVALID_CREDENTIALS', message: 'wrong password', details: {} },
      });
    });
    const client = new ApiClient({
      baseUrl: 'https://api.test',
      refreshToken: 'refresh-1',
      fetchImpl,
    });

    await expect(client.login({ email: 'a@x.com', password: 'wrong' })).rejects.toBeInstanceOf(
      ApiError,
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe('https://api.test/v1/auth/login');
  });

  it('does not attempt refresh when no refresh token is configured', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push(captureRequest(input, init));
      return buildResponse(401, {
        error: { code: 'UNAUTHENTICATED', message: 'no creds', details: {} },
      });
    });
    const client = new ApiClient({
      baseUrl: 'https://api.test',
      accessToken: 'access-1',
      fetchImpl,
    });
    await expect(client.request('/v1/me')).rejects.toBeInstanceOf(ApiError);
    expect(captured).toHaveLength(1);
  });

  it('forwards the abort signal to fetch', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      return buildResponse(200, {});
    });
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl });
    await client.request('/v1/me', { signal: controller.signal });
  });
});
