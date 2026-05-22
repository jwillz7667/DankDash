import { describe, expect, it, vi } from 'vitest';
import type { LoginMfaRequiredResponse, LoginSuccessResponse, UserRole } from '../api/types.js';
import { buildAuthConfig, MfaRequiredError } from './config.js';

interface CapturedFetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
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

describe('buildAuthConfig', () => {
  it('authorize() returns the portal-shaped user on a successful sign-in', async () => {
    const captured: CapturedFetchCall[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      captured.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body !== undefined ? JSON.parse(init.body as string) : undefined,
      });
      return new Response(JSON.stringify(buildSuccessResponse('manager', true)), { status: 200 });
    });

    const config = buildAuthConfig({
      apiBaseUrl: 'https://api.test',
      authSecret: 'a'.repeat(32),
      fetchImpl: fetchImpl as unknown as typeof fetch,
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
