/**
 * @RateLimit() — handler-level decorator the global RateLimitGuard reads.
 *
 * Each rule names the policy ('login-per-ip'), the value to track ('ip',
 * 'email-from-body', etc.), the per-window limit, and the window length.
 * Multiple rules can stack on one handler so a single endpoint can be
 * gated by independent counters (login is per-IP AND per-email).
 *
 * `tracker` strategies (resolved in RateLimitGuard.resolveTracker):
 *
 *   'ip'                 — request IP, normalized through req.ip (Fastify
 *                          + trustProxy gives us the client's real IP).
 *   'email-from-body'    — hashes the body.email field. Used for
 *                          /v1/auth/login so credential-stuffing across a
 *                          rotating IP pool against one account is still
 *                          throttled.
 *   'refresh-from-body'  — hashes the body.refreshToken field. Used for
 *                          /v1/auth/refresh; the refresh token uniquely
 *                          identifies a user-device session pre-auth.
 *   'user'               — req.user.userId attached by JwtAuthGuard.
 *                          Used for authenticated endpoints.
 *
 * Trackers are hashed before forming the Redis key so that an operator
 * who inspects Redis cannot read user emails or refresh tokens. Bucketed
 * keys are bounded length and prefix-scoped per policy name to keep
 * SCAN traffic for ops dashboards readable.
 *
 * NOTE: the @RateLimit metadata is additive — applying @RateLimit twice
 * on one handler is supported because Reflect.getMetadata returns the
 * last call. Use the array overload to set multiple rules.
 */
import assert from 'node:assert/strict';
import { SetMetadata, applyDecorators } from '@nestjs/common';

export const RATE_LIMIT_METADATA_KEY = 'dankdash:rate-limit';

export type RateLimitTracker = 'ip' | 'email-from-body' | 'refresh-from-body' | 'user';

export interface RateLimitRule {
  /** Stable policy name. Forms part of the Redis key. */
  readonly name: string;
  readonly tracker: RateLimitTracker;
  /** Maximum hits per window. */
  readonly limit: number;
  /** Window length in milliseconds. */
  readonly windowMs: number;
}

export function RateLimit(...rules: readonly RateLimitRule[]): MethodDecorator & ClassDecorator {
  // Programmer error: catches `@RateLimit()` typo at module-load time
  // rather than letting the handler register with no actual rules.
  assert(rules.length > 0, '@RateLimit requires at least one rule');
  return applyDecorators(SetMetadata(RATE_LIMIT_METADATA_KEY, rules));
}
