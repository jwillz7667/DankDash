/**
 * Unit tests for RateLimitGuard.
 *
 * Exercised against MemoryRateLimitStore with an injectable clock so the
 * fixed-window semantics are deterministic. We assert:
 *
 *   - No @RateLimit metadata short-circuits to allow.
 *   - Single-rule policies count, allow up to limit, then throw.
 *   - The Fastify req.ip path is the IP tracker source of truth.
 *   - 'user' tracker reads req.user.userId attached by JwtAuthGuard.
 *   - 'email-from-body' lower-cases its value so 'Jane@…' / 'jane@…' bucket
 *      together (the auth service's DTO normalisation runs AFTER guards).
 *   - 'refresh-from-body' reads the refreshToken field literally.
 *   - Missing tracker values skip the rule (do NOT count empties — that
 *     would let a single mis-shaped request burn through every other
 *     caller's budget against the empty-string bucket).
 *   - Multi-tracker rules (login pattern: per-IP AND per-email) count
 *     independently and either one tripping rejects the request.
 *   - Tracker values are sha256-hashed before forming the Redis key so a
 *     raw email never lands in storage; identical raw values produce
 *     identical key suffixes.
 *
 * No Redis, no HTTP transport, no Nest container — the guard's contract
 * is small enough that a hand-built ExecutionContext is faster and more
 * legible than spinning the app.
 */
import { createHash } from 'node:crypto';
import { RateLimitError } from '@dankdash/types';
import { Reflector } from '@nestjs/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { RATE_LIMIT_METADATA_KEY, type RateLimitRule } from '../decorators/rate-limit.decorator.js';
import { MemoryRateLimitStore } from '../rate-limit/rate-limit-store.js';
import { RateLimitGuard } from './rate-limit.guard.js';
import type { AuthenticatedUser } from '../../modules/auth/guards/auth-types.js';
import type { ExecutionContext } from '@nestjs/common';

interface FakeRequest {
  readonly ip: string;
  readonly headers: Record<string, string | undefined>;
  readonly body?: unknown;
  user?: AuthenticatedUser;
}

// Tagged so `@typescript-eslint/no-extraneous-class` doesn't flag an empty
// shell — the controller stand-in only needs to be a class constructor for
// Reflector.getAllAndOverride to walk class-level metadata.
class FakeController {
  readonly kind = 'fake-controller' as const;
}

function makeContext(
  req: FakeRequest,
  rules: readonly RateLimitRule[] | undefined,
): { ctx: ExecutionContext; reflector: Reflector } {
  const handler = (): void => undefined;
  const reflector = new Reflector();
  if (rules !== undefined) {
    Reflect.defineMetadata(RATE_LIMIT_METADATA_KEY, rules, handler);
  }
  // Hand-rolled ExecutionContext: ArgumentsHost's generics are heavier than
  // useful for a guard that only reaches for the HTTP request, so we cast at
  // the construction site rather than satisfy six unused type parameters.
  const ctx = {
    getHandler: (): unknown => handler,
    getClass: (): unknown => FakeController,
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
  return { ctx, reflector };
}

const MINUTE_MS = 60_000;

describe('RateLimitGuard', () => {
  let store: MemoryRateLimitStore;
  let now: number;

  beforeEach(() => {
    now = 1_700_000_000_000;
    store = new MemoryRateLimitStore(() => now);
  });

  it('allows the call when no @RateLimit metadata is present', async () => {
    const { ctx, reflector } = makeContext({ ip: '1.2.3.4', headers: {} }, undefined);
    const guard = new RateLimitGuard(reflector, store);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(store.size()).toBe(0);
  });

  it('allows hits up to the per-IP limit, then throws RateLimitError', async () => {
    const rule: RateLimitRule = {
      name: 'auth-register-ip',
      tracker: 'ip',
      limit: 3,
      windowMs: MINUTE_MS,
    };
    const { ctx, reflector } = makeContext({ ip: '9.9.9.9', headers: {} }, [rule]);
    const guard = new RateLimitGuard(reflector, store);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(RateLimitError);
  });

  it('attaches policy + retry metadata to the thrown RateLimitError', async () => {
    const rule: RateLimitRule = {
      name: 'auth-register-ip',
      tracker: 'ip',
      limit: 1,
      windowMs: MINUTE_MS,
    };
    const { ctx, reflector } = makeContext({ ip: '9.9.9.9', headers: {} }, [rule]);
    const guard = new RateLimitGuard(reflector, store);

    await guard.canActivate(ctx);
    now += 100;
    try {
      await guard.canActivate(ctx);
      expect.fail('expected RateLimitError');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      const details = (err as RateLimitError).details;
      expect(details).toMatchObject({
        policy: 'auth-register-ip',
        limit: 1,
        windowMs: MINUTE_MS,
      });
      expect(typeof details['retryAfterMs']).toBe('number');
    }
  });

  it('resets the window once windowMs elapses', async () => {
    const rule: RateLimitRule = {
      name: 'auth-register-ip',
      tracker: 'ip',
      limit: 1,
      windowMs: MINUTE_MS,
    };
    const { ctx, reflector } = makeContext({ ip: '9.9.9.9', headers: {} }, [rule]);
    const guard = new RateLimitGuard(reflector, store);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(RateLimitError);
    now += MINUTE_MS + 1;
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it("uses req.user.userId for the 'user' tracker", async () => {
    const rule: RateLimitRule = {
      name: 'auth-default-user',
      tracker: 'user',
      limit: 2,
      windowMs: MINUTE_MS,
    };
    const user: AuthenticatedUser = {
      userId: '01935f3d-0000-7000-8000-000000000001',
      sessionId: '01935f3d-0000-7000-8000-000000000099',
      role: 'customer',
    };
    const { ctx, reflector } = makeContext({ ip: '1.2.3.4', headers: {}, user }, [rule]);
    const guard = new RateLimitGuard(reflector, store);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("skips the rule when 'user' tracker has no req.user (e.g. @Public route)", async () => {
    const rule: RateLimitRule = {
      name: 'auth-default-user',
      tracker: 'user',
      limit: 1,
      windowMs: MINUTE_MS,
    };
    const { ctx, reflector } = makeContext({ ip: '1.2.3.4', headers: {} }, [rule]);
    const guard = new RateLimitGuard(reflector, store);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(store.size()).toBe(0);
  });

  it("lower-cases 'email-from-body' so case variants bucket together", async () => {
    const rule: RateLimitRule = {
      name: 'auth-login-email',
      tracker: 'email-from-body',
      limit: 2,
      windowMs: MINUTE_MS,
    };
    const guard = new RateLimitGuard(new Reflector(), store);

    const upper = makeContext({ ip: '1.1.1.1', headers: {}, body: { email: 'Jane@Example.com' } }, [
      rule,
    ]);
    const lower = makeContext({ ip: '2.2.2.2', headers: {}, body: { email: 'jane@example.com' } }, [
      rule,
    ]);

    await expect(guard.canActivate(upper.ctx)).resolves.toBe(true);
    await expect(guard.canActivate(lower.ctx)).resolves.toBe(true);
    await expect(guard.canActivate(upper.ctx)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("skips 'email-from-body' when the body lacks a string email", async () => {
    const rule: RateLimitRule = {
      name: 'auth-login-email',
      tracker: 'email-from-body',
      limit: 1,
      windowMs: MINUTE_MS,
    };
    const guard = new RateLimitGuard(new Reflector(), store);

    const empty = makeContext({ ip: '1.1.1.1', headers: {}, body: {} }, [rule]);
    const numeric = makeContext({ ip: '2.2.2.2', headers: {}, body: { email: 42 } }, [rule]);
    const noBody = makeContext({ ip: '3.3.3.3', headers: {} }, [rule]);

    await expect(guard.canActivate(empty.ctx)).resolves.toBe(true);
    await expect(guard.canActivate(numeric.ctx)).resolves.toBe(true);
    await expect(guard.canActivate(noBody.ctx)).resolves.toBe(true);
    expect(store.size()).toBe(0);
  });

  it("reads 'refresh-from-body' from body.refreshToken", async () => {
    const rule: RateLimitRule = {
      name: 'auth-refresh',
      tracker: 'refresh-from-body',
      limit: 2,
      windowMs: MINUTE_MS,
    };
    const guard = new RateLimitGuard(new Reflector(), store);

    const a = makeContext(
      { ip: '1.1.1.1', headers: {}, body: { refreshToken: 'opaque-token-aaa' } },
      [rule],
    );
    const b = makeContext(
      { ip: '2.2.2.2', headers: {}, body: { refreshToken: 'opaque-token-bbb' } },
      [rule],
    );

    await expect(guard.canActivate(a.ctx)).resolves.toBe(true);
    await expect(guard.canActivate(a.ctx)).resolves.toBe(true);
    await expect(guard.canActivate(a.ctx)).rejects.toBeInstanceOf(RateLimitError);
    // Different token gets its own bucket.
    await expect(guard.canActivate(b.ctx)).resolves.toBe(true);
  });

  it('enforces multi-tracker rules independently (login: per-IP AND per-email)', async () => {
    const perIp: RateLimitRule = {
      name: 'auth-login-ip',
      tracker: 'ip',
      limit: 5,
      windowMs: MINUTE_MS,
    };
    const perEmail: RateLimitRule = {
      name: 'auth-login-email',
      tracker: 'email-from-body',
      limit: 10,
      windowMs: MINUTE_MS,
    };
    const guard = new RateLimitGuard(new Reflector(), store);

    // One IP cycles through 5 distinct emails — trips the per-IP rule on
    // hit #6 even though no single email is anywhere near 10.
    for (let i = 1; i <= 5; i += 1) {
      const ctx = makeContext(
        { ip: '7.7.7.7', headers: {}, body: { email: `victim${String(i)}@example.com` } },
        [perIp, perEmail],
      ).ctx;
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    }
    const sixth = makeContext(
      { ip: '7.7.7.7', headers: {}, body: { email: 'victim6@example.com' } },
      [perIp, perEmail],
    ).ctx;
    await expect(guard.canActivate(sixth)).rejects.toMatchObject({
      details: { policy: 'auth-login-ip' },
    });
  });

  it('trips the per-email rule when one address is hammered from many IPs', async () => {
    const perIp: RateLimitRule = {
      name: 'auth-login-ip',
      tracker: 'ip',
      limit: 5,
      windowMs: MINUTE_MS,
    };
    const perEmail: RateLimitRule = {
      name: 'auth-login-email',
      tracker: 'email-from-body',
      limit: 10,
      windowMs: MINUTE_MS,
    };
    const guard = new RateLimitGuard(new Reflector(), store);

    for (let i = 1; i <= 10; i += 1) {
      const ctx = makeContext(
        { ip: `10.0.0.${String(i)}`, headers: {}, body: { email: 'victim@example.com' } },
        [perIp, perEmail],
      ).ctx;
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    }
    const eleventh = makeContext(
      { ip: '10.0.0.11', headers: {}, body: { email: 'victim@example.com' } },
      [perIp, perEmail],
    ).ctx;
    await expect(guard.canActivate(eleventh)).rejects.toMatchObject({
      details: { policy: 'auth-login-email' },
    });
  });

  it('hashes the tracker value before keying the store (PII never lands raw)', async () => {
    const rule: RateLimitRule = {
      name: 'auth-login-email',
      tracker: 'email-from-body',
      limit: 5,
      windowMs: MINUTE_MS,
    };
    const guard = new RateLimitGuard(new Reflector(), store);
    const ctx = makeContext({ ip: '1.1.1.1', headers: {}, body: { email: 'jane@example.com' } }, [
      rule,
    ]).ctx;
    await guard.canActivate(ctx);

    const expectedSuffix = createHash('sha256')
      .update('jane@example.com')
      .digest('hex')
      .slice(0, 16);
    const expectedKey = `rl:auth-login-email:${expectedSuffix}`;

    expect(store.size()).toBe(1);
    expect(
      Array.from((store as unknown as { entries: Map<string, unknown> }).entries.keys()),
    ).toEqual([expectedKey]);
  });
});
