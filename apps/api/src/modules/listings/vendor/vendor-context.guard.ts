/**
 * VendorContextGuard — second-layer guard for vendor-scoped routes.
 *
 *   1. Reads the `X-Dispensary-Id` header. Missing or non-UUID → 422
 *      (the request itself is malformed, distinct from 401/403).
 *   2. Verifies the authenticated principal is an *active* staff member of
 *      that dispensary via `dispensary_staff` (`removedAt IS NULL`). Any
 *      mismatch — header references a dispensary the user does not staff,
 *      or the membership has been revoked — surfaces as 403. Returning
 *      404 on the dispensary itself would leak existence; the user *did*
 *      authenticate, just not for this context.
 *   3. Attaches a typed VendorContext to the request so handler params
 *      can pull it via `@CurrentDispensary()` instead of re-running the
 *      lookup. Also rebinds the request user's role to the per-dispensary
 *      `staffRole` is intentionally NOT done — the global role on the
 *      JWT remains authoritative for `@Roles(...)` checks.
 *
 * Runs after JwtAuthGuard (global) and before RolesGuard (route-local).
 * RolesGuard gates *which staff roles* may hit a route (e.g. POST may
 * require `manager` or `owner`); this guard owns the "is the principal
 * legitimately acting on behalf of this dispensary" question.
 *
 * Active membership is defined by `removedAt IS NULL`. An invited-but-
 * unaccepted staff member (`acceptedAt IS NULL`) is *not* gated here —
 * the unaccepted state is for invitation UX, not authorization. Routes
 * that require an accepted membership (Phase 5 onwards) can layer that
 * check on the returned VendorContext via the decorator's metadata.
 */
import { DispensaryStaffRepository } from '@dankdash/db';
import { AuthError, ForbiddenError, ValidationError } from '@dankdash/types';
import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { VENDOR_CONTEXT_REQUEST_KEY, type VendorContext } from './vendor-context.types.js';
import type { AuthenticatedUser } from '../../auth/guards/auth-types.js';
import type { FastifyRequest } from 'fastify';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DISPENSARY_HEADER = 'x-dispensary-id';

interface RequestWithUserAndContext extends FastifyRequest {
  user?: AuthenticatedUser;
  [VENDOR_CONTEXT_REQUEST_KEY]?: VendorContext;
}

@Injectable()
export class VendorContextGuard implements CanActivate {
  constructor(private readonly staff: DispensaryStaffRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithUserAndContext>();

    const user = req.user;
    if (user === undefined) {
      // VendorContextGuard runs after the global JwtAuthGuard, so a missing
      // user here means the route was incorrectly marked @Public yet still
      // applied this guard. That's a controller-coding mistake; fail loud.
      throw new AuthError(
        'UNAUTHENTICATED',
        'vendor route reached without an authenticated principal',
      );
    }

    const headerValue = req.headers[DISPENSARY_HEADER];
    if (typeof headerValue !== 'string' || headerValue.length === 0) {
      throw new ValidationError('Missing required header X-Dispensary-Id', {
        header: 'X-Dispensary-Id',
      });
    }
    if (!UUID_REGEX.test(headerValue)) {
      throw new ValidationError('X-Dispensary-Id must be a UUID', {
        header: 'X-Dispensary-Id',
        value: headerValue,
      });
    }

    const membership = await this.staff.findByDispensaryAndUser(headerValue, user.userId);
    if (membership?.removedAt !== null) {
      throw new ForbiddenError(
        'Authenticated user is not an active staff member of the requested dispensary',
        { dispensaryId: headerValue },
      );
    }

    req[VENDOR_CONTEXT_REQUEST_KEY] = {
      dispensaryId: membership.dispensaryId,
      userId: user.userId,
      staffRole: membership.role,
      staffMemberId: membership.id,
    };
    return true;
  }
}
