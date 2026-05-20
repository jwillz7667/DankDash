import { describe, expect, it, vi } from 'vitest';
import type {
  DispensaryMembership,
  DispensaryMembershipsResponse,
  LoginMfaRequiredResponse,
  LoginSuccessResponse,
  UserRole,
} from '../api/types.js';
import { buildAuthConfig, MfaRequiredError } from './config.js';

interface CapturedFetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

type AuthorizeFn = (credentials: Record<string, unknown>, request: Request) => Promise<unknown>;

function getAuthorize(config: ReturnType<typeof buildAuthConfig>): AuthorizeFn {
  // @auth/core's `Credentials(...)` factory wraps the caller-supplied config —
  // it sets `provider.authorize = () => null` and stashes the original on
  // `provider.options.authorize`. The runtime invokes the wrapped one through
  // its own pipeline; tests reach in and pull the underlying function out so
  // they don't have to spin up a real Auth.js request to exercise it.
  const providers = config.providers;
  if (!providers || providers.length === 0) {
    throw new Error('no providers');
  }
  const provider = providers[0] as unknown as {
    options?: { authorize?: AuthorizeFn };
    authorize?: AuthorizeFn;
  };
  const fn = provider.options?.authorize ?? provider.authorize;
  if (typeof fn !== 'function') {
    throw new Error('authorize not found on provider');
  }
  return fn;
}

function buildSuccessResponse(role: UserRole, mfaEnabled = false): LoginSuccessResponse {
  return {
    status: 'authenticated',
    user: {
      id: 'u-1',
      email: 'avery@dankdash.com',
      phone: null,
      firstName: 'Avery',
      lastName: 'Stone',
      role,
      status: 'active',
      kycVerified: true,
      mfaEnabled,
      createdAt: '2026-05-01T00:00:00Z',
    },
    tokens: {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      accessTokenExpiresAt: '2026-05-19T13:00:00Z',
      refreshTokenExpiresAt: '2026-06-02T13:00:00Z',
      tokenType: 'Bearer',
    },
  };
}

function buildMembership(overrides: Partial<DispensaryMembership> = {}): DispensaryMembership {
  return {
    id: '01935f3d-0000-7000-8000-0000000000d1',
    displayName: 'North Loop',
    staffRole: 'manager',
    acceptedAt: '2026-04-02T00:00:00.000+00:00',
    joinedAt: '2026-04-02T00:00:00.000+00:00',
    ...overrides,
  };
}

/**
 * URL-keyed fetch mock — matches by suffix so callers can write
 * `'/v1/auth/login'` regardless of the configured `apiBaseUrl`. Falls
 * back to the catch-all `default` route when no path matches, or throws
 * if none is configured. Captures every call into the supplied buffer
 * so tests can assert ordering and headers.
 */
function mockFetchByPath(
  routes: Record<string, () => Response>,
  captured: CapturedFetchCall[],
): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw instanceof Headers) {
      raw.forEach((value, key) => {
        headers[key] = value;
      });
    } else if (raw) {
      Object.assign(headers, raw as Record<string, string>);
    }
    captured.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body !== undefined ? JSON.parse(init.body as string) : undefined,
      headers,
    });
    for (const [path, fn] of Object.entries(routes)) {
      if (path === 'default') continue;
      if (url.endsWith(path)) return fn();
    }
    const fallback = routes['default'];
    if (fallback !== undefined) return fallback();
    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;
}

function membershipsResponse(
  ...memberships: readonly DispensaryMembership[]
): DispensaryMembershipsResponse {
  return { memberships };
}

describe('buildAuthConfig', () => {
  it('authorize() returns the portal-shaped user on a successful sign-in', async () => {
    const captured: CapturedFetchCall[] = [];
    const fetchImpl = mockFetchByPath(
      {
        '/v1/auth/login': () =>
          new Response(JSON.stringify(buildSuccessResponse('manager', true)), { status: 200 }),
        '/v1/me/dispensaries': () =>
          new Response(JSON.stringify(membershipsResponse(buildMembership())), { status: 200 }),
      },
      captured,
    );

    const config = buildAuthConfig({
      apiBaseUrl: 'https://api.test',
      authSecret: 'a'.repeat(32),
      fetchImpl,
    });

    const authorize = getAuthorize(config);
    const result = await authorize(
      { mode: 'password', email: 'avery@dankdash.com', password: 'super' },
      new Request('https://portal.test/login'),
    );

    expect(result).toMatchObject({
      id: 'u-1',
      email: 'avery@dankdash.com',
      role: 'manager',
      mfaEnabled: true,
      // manager + mfaEnabled=true → no further MFA needed
      mfaRequired: false,
      accessToken: 'access-1',
    });
    expect(captured[0]?.url).toBe('https://api.test/v1/auth/login');
    expect(captured[0]?.method).toBe('POST');
    expect(captured[0]?.body).toEqual({ email: 'avery@dankdash.com', password: 'super' });
  });

  it('authorize() flags mfaRequired for manager roles without MFA enrolled', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(buildSuccessResponse('owner', false)), { status: 200 }),
    );
    const config = buildAuthConfig({
      apiBaseUrl: 'https://api.test',
      authSecret: 'a'.repeat(32),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = (await getAuthorize(config)(
      { mode: 'password', email: 'a@x.com', password: 'p' },
      new Request('https://portal.test/login'),
    )) as { readonly mfaRequired: boolean; readonly role: string };

    expect(result.role).toBe('owner');
    expect(result.mfaRequired).toBe(true);
  });

  it('authorize() throws MfaRequiredError on a mfa_required response (first leg of two-step)', async () => {
    const mfaResponse: LoginMfaRequiredResponse = {
      status: 'mfa_required',
      challengeId: 'ch-1',
      challengeExpiresAt: '2026-05-19T12:05:00Z',
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(mfaResponse), { status: 200 }));
    const config = buildAuthConfig({
      apiBaseUrl: 'https://api.test',
      authSecret: 'a'.repeat(32),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      getAuthorize(config)(
        { mode: 'password', email: 'a@x.com', password: 'p' },
        new Request('https://portal.test/login'),
      ),
    ).rejects.toBeInstanceOf(MfaRequiredError);

    // The error's `code` is what reaches the client — it's the only
    // way the login form can tell "needs MFA" apart from "wrong pw".
    try {
      await getAuthorize(config)(
        { mode: 'password', email: 'a@x.com', password: 'p' },
        new Request('https://portal.test/login'),
      );
      expect.fail('expected MfaRequiredError');
    } catch (err) {
      expect((err as MfaRequiredError).code).toBe('mfa_required');
    }
  });

  it('authorize() returns null when the API rejects (no leaking of which field was wrong)', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'INVALID_CREDENTIALS',
              message: 'no such account',
              details: {},
            },
          }),
          { status: 401 },
        ),
    );
    const config = buildAuthConfig({
      apiBaseUrl: 'https://api.test',
      authSecret: 'a'.repeat(32),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await getAuthorize(config)(
      { mode: 'password', email: 'a@x.com', password: 'p' },
      new Request('https://portal.test/login'),
    );
    expect(result).toBeNull();
  });

  it('authorize() rejects non-portal roles (customer, driver) outright', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(buildSuccessResponse('customer', false)), { status: 200 }),
    );
    const config = buildAuthConfig({
      apiBaseUrl: 'https://api.test',
      authSecret: 'a'.repeat(32),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await getAuthorize(config)(
      { mode: 'password', email: 'a@x.com', password: 'p' },
      new Request('https://portal.test/login'),
    );
    expect(result).toBeNull();
  });

  it('authorize() returns null on malformed credential input', async () => {
    const fetchImpl = vi.fn();
    const config = buildAuthConfig({
      apiBaseUrl: 'https://api.test',
      authSecret: 'a'.repeat(32),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await getAuthorize(config)(
      { mode: 'password', email: '', password: '' },
      new Request('https://portal.test/login'),
    );
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('authorize() persists the first accepted dispensary membership on the user object', async () => {
    const captured: CapturedFetchCall[] = [];
    const fetchImpl = mockFetchByPath(
      {
        '/v1/auth/login': () =>
          new Response(JSON.stringify(buildSuccessResponse('manager', true)), { status: 200 }),
        '/v1/me/dispensaries': () =>
          new Response(
            JSON.stringify(
              membershipsResponse(
                buildMembership({
                  id: '01935f3d-0000-7000-8000-0000000000d1',
                  displayName: 'North Loop',
                  staffRole: 'manager',
                }),
                buildMembership({
                  id: '01935f3d-0000-7000-8000-0000000000d2',
                  displayName: 'Uptown',
                  staffRole: 'budtender',
                }),
              ),
            ),
            { status: 200 },
          ),
      },
      captured,
    );
    const config = buildAuthConfig({
      apiBaseUrl: 'https://api.test',
      authSecret: 'a'.repeat(32),
      fetchImpl,
    });

    const result = (await getAuthorize(config)(
      { mode: 'password', email: 'a@x.com', password: 'p' },
      new Request('https://portal.test/login'),
    )) as {
      readonly dispensaryId: string | null;
      readonly dispensaryName: string | null;
      readonly staffRole: string | null;
    };

    expect(result.dispensaryId).toBe('01935f3d-0000-7000-8000-0000000000d1');
    expect(result.dispensaryName).toBe('North Loop');
    expect(result.staffRole).toBe('manager');
    // Login first, then dispensaries — with the bearer token from login.
    expect(captured.map((c) => c.url)).toEqual([
      'https://api.test/v1/auth/login',
      'https://api.test/v1/me/dispensaries',
    ]);
    expect(captured[1]?.headers['Authorization']).toBe('Bearer access-1');
  });

  it('authorize() leaves dispensary fields null when the user has no memberships', async () => {
    const captured: CapturedFetchCall[] = [];
    const fetchImpl = mockFetchByPath(
      {
        '/v1/auth/login': () =>
          new Response(JSON.stringify(buildSuccessResponse('admin', true)), { status: 200 }),
        '/v1/me/dispensaries': () =>
          new Response(JSON.stringify(membershipsResponse()), { status: 200 }),
      },
      captured,
    );
    const config = buildAuthConfig({
      apiBaseUrl: 'https://api.test',
      authSecret: 'a'.repeat(32),
      fetchImpl,
    });
    const result = (await getAuthorize(config)(
      { mode: 'password', email: 'a@x.com', password: 'p' },
      new Request('https://portal.test/login'),
    )) as { readonly dispensaryId: unknown; readonly staffRole: unknown };

    expect(result.dispensaryId).toBeNull();
    expect(result.staffRole).toBeNull();
  });

  it('authorize() skips pending invites (acceptedAt = null) when picking the active dispensary', async () => {
    const captured: CapturedFetchCall[] = [];
    const fetchImpl = mockFetchByPath(
      {
        '/v1/auth/login': () =>
          new Response(JSON.stringify(buildSuccessResponse('manager', true)), { status: 200 }),
        '/v1/me/dispensaries': () =>
          new Response(
            JSON.stringify(
              membershipsResponse(
                buildMembership({
                  id: '01935f3d-0000-7000-8000-0000000000d1',
                  displayName: 'Pending Invite Store',
                  acceptedAt: null,
                }),
                buildMembership({
                  id: '01935f3d-0000-7000-8000-0000000000d2',
                  displayName: 'Accepted Store',
                }),
              ),
            ),
            { status: 200 },
          ),
      },
      captured,
    );
    const config = buildAuthConfig({
      apiBaseUrl: 'https://api.test',
      authSecret: 'a'.repeat(32),
      fetchImpl,
    });
    const result = (await getAuthorize(config)(
      { mode: 'password', email: 'a@x.com', password: 'p' },
      new Request('https://portal.test/login'),
    )) as { readonly dispensaryId: string | null; readonly dispensaryName: string | null };

    expect(result.dispensaryName).toBe('Accepted Store');
    expect(result.dispensaryId).toBe('01935f3d-0000-7000-8000-0000000000d2');
  });

  it('authorize() fails open when the dispensaries fetch errors (5xx)', async () => {
    const captured: CapturedFetchCall[] = [];
    const fetchImpl = mockFetchByPath(
      {
        '/v1/auth/login': () =>
          new Response(JSON.stringify(buildSuccessResponse('manager', true)), { status: 200 }),
        '/v1/me/dispensaries': () =>
          new Response(
            JSON.stringify({
              error: { code: 'INTERNAL', message: 'oops', details: {} },
            }),
            { status: 500 },
          ),
      },
      captured,
    );
    const config = buildAuthConfig({
      apiBaseUrl: 'https://api.test',
      authSecret: 'a'.repeat(32),
      fetchImpl,
    });
    const result = (await getAuthorize(config)(
      { mode: 'password', email: 'a@x.com', password: 'p' },
      new Request('https://portal.test/login'),
    )) as { readonly id: string; readonly dispensaryId: string | null };

    // Sign-in still succeeds — dashboard renders a "no context" state.
    expect(result.id).toBe('u-1');
    expect(result.dispensaryId).toBeNull();
  });

  it('authorize() does NOT fetch dispensaries when MFA is still pending (saves the round trip)', async () => {
    const captured: CapturedFetchCall[] = [];
    const fetchImpl = mockFetchByPath(
      {
        // owner + mfaEnabled=false → mfaRequired=true, dispensaries fetch is
        // skipped until the second factor lands. /two-factor will re-sign-in
        // after the TOTP verifies, at which point mfaEnabled=true and the
        // fetch happens.
        '/v1/auth/login': () =>
          new Response(JSON.stringify(buildSuccessResponse('owner', false)), { status: 200 }),
        '/v1/me/dispensaries': () => {
          throw new Error('dispensaries should not be fetched while MFA is pending');
        },
      },
      captured,
    );
    const config = buildAuthConfig({
      apiBaseUrl: 'https://api.test',
      authSecret: 'a'.repeat(32),
      fetchImpl,
    });
    const result = (await getAuthorize(config)(
      { mode: 'password', email: 'a@x.com', password: 'p' },
      new Request('https://portal.test/login'),
    )) as { readonly mfaRequired: boolean; readonly dispensaryId: unknown };

    expect(result.mfaRequired).toBe(true);
    expect(result.dispensaryId).toBeNull();
    expect(captured.map((c) => c.url)).toEqual(['https://api.test/v1/auth/login']);
  });

  it('exposes JWT session strategy with the project-mandated TTL', () => {
    const config = buildAuthConfig({
      apiBaseUrl: 'https://api.test',
      authSecret: 'a'.repeat(32),
    });
    expect(config.session?.strategy).toBe('jwt');
    expect(config.session?.maxAge).toBe(60 * 60 * 24 * 14);
  });

  it('sets the sign-in and error pages to /login', () => {
    const config = buildAuthConfig({
      apiBaseUrl: 'https://api.test',
      authSecret: 'a'.repeat(32),
    });
    expect(config.pages?.signIn).toBe('/login');
    expect(config.pages?.error).toBe('/login');
  });
});
