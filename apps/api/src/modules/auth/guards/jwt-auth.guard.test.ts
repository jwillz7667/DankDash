/**
 * Unit tests for JwtAuthGuard.
 *
 * Covers the four canActivate paths:
 *   1. @Public route — short-circuits with no header read.
 *   2. Missing/malformed Authorization header — AuthError UNAUTHENTICATED.
 *   3. Token verifies but carries an unknown role — AuthError TOKEN_INVALID.
 *   4. Token verifies cleanly — attaches { userId, sessionId, role } to req.
 *
 * The JwtService is faked so we exercise the guard's branching without the
 * RS256 crypto path (that path is fully covered by jwt.service.test.ts).
 */
import { AuthError } from '@dankdash/types';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import type { AuthenticatedUser } from './auth-types.js';
import type { AccessTokenClaims, JwtService } from '../jwt/jwt.service.js';
import type { ExecutionContext } from '@nestjs/common';

interface FakeRequest {
  readonly headers: Record<string, string | undefined>;
  user?: AuthenticatedUser;
}

class FakeProtectedController {
  readonly kind = 'fake-protected' as const;
}

function makeContext(req: FakeRequest, opts: { isPublic?: boolean } = {}): ExecutionContext {
  const handler = (): void => undefined;
  if (opts.isPublic === true) {
    Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
  }
  return {
    getHandler: (): unknown => handler,
    getClass: (): unknown => FakeProtectedController,
    switchToHttp: (): unknown => ({
      getRequest: (): FakeRequest => req,
      getResponse: (): unknown => ({}),
      getNext: (): unknown => ({}),
    }),
    switchToRpc: (): unknown => ({}),
    switchToWs: (): unknown => ({}),
    getArgs: (): readonly unknown[] => [],
    getArgByIndex: (): unknown => undefined,
    getType: (): string => 'http',
  } as unknown as ExecutionContext;
}

class FakeJwtService {
  // Default: returns a happy-path claim. Each test that wants a different
  // behaviour overrides .nextClaims or .nextError before calling the guard.
  nextClaims: AccessTokenClaims = {
    sub: '01935f3d-0000-7000-8000-000000000001',
    sid: '01935f3d-0000-7000-8000-000000000099',
    role: 'customer',
    iss: 'dankdash',
    aud: 'dankdash-clients',
    iat: 1_700_000_000,
    exp: 1_700_000_900,
    kid: 'test-kid',
  };
  nextError: AuthError | null = null;
  readonly calls: string[] = [];

  verifyAccessToken = (token: string): AccessTokenClaims => {
    this.calls.push(token);
    if (this.nextError !== null) throw this.nextError;
    return this.nextClaims;
  };
}

describe('JwtAuthGuard', () => {
  const buildGuard = (): { guard: JwtAuthGuard; jwt: FakeJwtService } => {
    const jwt = new FakeJwtService();
    const guard = new JwtAuthGuard(new Reflector(), jwt as unknown as JwtService);
    return { guard, jwt };
  };

  it('short-circuits when the route is @Public', () => {
    const { guard, jwt } = buildGuard();
    const req: FakeRequest = { headers: {} };

    expect(guard.canActivate(makeContext(req, { isPublic: true }))).toBe(true);
    expect(jwt.calls).toHaveLength(0);
    expect(req.user).toBeUndefined();
  });

  it('throws UNAUTHENTICATED when the Authorization header is missing', () => {
    const { guard } = buildGuard();
    const req: FakeRequest = { headers: {} };

    expect(() => guard.canActivate(makeContext(req))).toThrowError(AuthError);
  });

  it('throws UNAUTHENTICATED when the Authorization header is not a Bearer scheme', () => {
    const { guard } = buildGuard();
    const req: FakeRequest = { headers: { authorization: 'Basic Zm9vOmJhcg==' } };

    try {
      guard.canActivate(makeContext(req));
      expect.fail('expected AuthError');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).code).toBe('UNAUTHENTICATED');
    }
  });

  it('throws UNAUTHENTICATED when the Bearer value is whitespace only', () => {
    const { guard } = buildGuard();
    const req: FakeRequest = { headers: { authorization: 'Bearer    ' } };

    expect(() => guard.canActivate(makeContext(req))).toThrowError(AuthError);
  });

  it('throws TOKEN_INVALID when the verified claim carries an unknown role', () => {
    const { guard, jwt } = buildGuard();
    jwt.nextClaims = { ...jwt.nextClaims, role: 'sysop' };
    const req: FakeRequest = { headers: { authorization: 'Bearer good.jwt.value' } };

    try {
      guard.canActivate(makeContext(req));
      expect.fail('expected AuthError');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).code).toBe('TOKEN_INVALID');
      expect((err as AuthError).details).toMatchObject({ role: 'sysop' });
    }
  });

  it('re-raises AuthError verbatim when JwtService rejects the token', () => {
    const { guard, jwt } = buildGuard();
    jwt.nextError = new AuthError('TOKEN_EXPIRED', 'access token has expired');
    const req: FakeRequest = { headers: { authorization: 'Bearer expired.jwt.value' } };

    try {
      guard.canActivate(makeContext(req));
      expect.fail('expected AuthError');
    } catch (err) {
      expect((err as AuthError).code).toBe('TOKEN_EXPIRED');
    }
  });

  it('attaches { userId, sessionId, role } to req.user on a clean verify', () => {
    const { guard, jwt } = buildGuard();
    const req: FakeRequest = { headers: { authorization: 'Bearer happy.jwt.value' } };

    expect(guard.canActivate(makeContext(req))).toBe(true);
    expect(req.user).toEqual({
      userId: jwt.nextClaims.sub,
      sessionId: jwt.nextClaims.sid,
      role: jwt.nextClaims.role,
    });
    expect(jwt.calls).toEqual(['happy.jwt.value']);
  });
});
