/**
 * Global rate-limit guard.
 *
 * Reads @RateLimit(...rules) metadata off the handler/class, resolves the
 * tracker value for each rule, increments a per-rule counter via
 * RateLimitStore, and rejects with RATE_LIMIT_EXCEEDED when any window is
 * exceeded.
 *
 * Ordering: bound globally AFTER JwtAuthGuard so the `user` tracker can
 * read `req.user`. NestJS applies global guards in declaration order, so
 * main.ts registers JwtAuthGuard first, then RateLimitGuard.
 *
 * Trackers without a value (e.g. `email-from-body` on a request whose
 * body lacks an `email` field) skip the rule rather than counting against
 * an empty bucket — counting empties would let a malicious client trip a
 * rule against the literal empty string for every other caller. The
 * absent tracker is a misconfiguration to surface in logs, not a security
 * boundary to enforce.
 *
 * Key format: `rl:<policy-name>:<sha256(tracker-value).slice(0,16)>`.
 * The hash protects raw emails / refresh tokens from leaking into Redis
 * inspection; 16 hex chars (64 bits) is well past collision-resistance
 * for the population sizes we care about (<10^9 entries per policy).
 */
import { createHash } from 'node:crypto';
import { RateLimitError } from '@dankdash/types';
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  RATE_LIMIT_METADATA_KEY,
  type RateLimitRule,
  type RateLimitTracker,
} from '../decorators/rate-limit.decorator.js';
import { RATE_LIMIT_STORE, type RateLimitStore } from '../rate-limit/rate-limit-store.js';
import type { AuthenticatedUser } from '../../modules/auth/guards/auth-types.js';
import type { FastifyRequest } from 'fastify';

interface RequestShape extends FastifyRequest {
  user?: AuthenticatedUser;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rules = this.reflector.getAllAndOverride<readonly RateLimitRule[] | undefined>(
      RATE_LIMIT_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (rules === undefined || rules.length === 0) return true;

    const req = context.switchToHttp().getRequest<RequestShape>();

    for (const rule of rules) {
      const trackerValue = resolveTracker(rule.tracker, req);
      if (trackerValue === null) continue;
      const key = `rl:${rule.name}:${hashTracker(trackerValue)}`;
      const hit = await this.store.hit(key, rule.windowMs);
      if (hit.count > rule.limit) {
        throw new RateLimitError(`rate limit exceeded for policy ${rule.name}`, {
          policy: rule.name,
          limit: rule.limit,
          windowMs: rule.windowMs,
          retryAfterMs: hit.resetMs,
        });
      }
    }
    return true;
  }
}

function resolveTracker(tracker: RateLimitTracker, req: RequestShape): string | null {
  switch (tracker) {
    case 'ip': {
      // Fastify + trustProxy resolves req.ip from X-Forwarded-For; if a
      // proxy stripped the header or the request came on the loopback
      // path, req.ip falls back to the socket address.
      return req.ip.length > 0 ? req.ip : null;
    }
    case 'user': {
      return req.user?.userId ?? null;
    }
    case 'email-from-body': {
      const email = readStringField(req.body, 'email');
      // Lower-case so 'Jane@ex.com' and 'jane@ex.com' bucket together —
      // the auth service already lower-cases at the DTO boundary, but
      // the guard runs BEFORE Zod parsing so we cannot rely on it here.
      return email === null ? null : email.toLowerCase();
    }
    case 'refresh-from-body': {
      return readStringField(req.body, 'refreshToken');
    }
  }
}

function readStringField(body: unknown, field: string): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function hashTracker(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
