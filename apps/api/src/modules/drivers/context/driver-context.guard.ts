/**
 * DriverContextGuard — second-layer guard for driver-scoped routes.
 *
 *   1. Reads the authenticated principal off the request (placed by
 *      JwtAuthGuard). Missing → throws AuthError UNAUTHENTICATED; a
 *      driver route reached without a principal is a controller-coding
 *      mistake (route omitted from the global auth scope).
 *   2. Refuses the request if the principal's global role is not
 *      `driver`. RolesGuard could enforce this, but driver routes have
 *      no other role overlay; doing the check here keeps the controller
 *      surface @UseGuards(DriverContextGuard) alone.
 *   3. Looks up the `drivers` row for the principal's userId. Drivers
 *      onboard via the admin endpoint (POST /v1/admin/drivers), so the
 *      driver-roled JWT principal is guaranteed to have a row — but a
 *      missing row still surfaces as 403 (not 404) so a probing call
 *      cannot distinguish "exists but not yours" from "doesn't exist".
 *   4. Attaches a typed DriverContext to the request so handler params
 *      can pull it via `@CurrentDriver()` instead of re-running the
 *      lookup. The context carries `drivers.id` (the PK that
 *      dispatch_offers and order.driver_id key on) plus the current
 *      status snapshot — handlers that need the latest status under a
 *      row lock must re-read the row inside their tx.
 *
 * Runs after JwtAuthGuard (global).
 */
import { DriversRepository } from '@dankdash/db';
import { AuthError, ForbiddenError } from '@dankdash/types';
import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { DRIVER_CONTEXT_REQUEST_KEY, type DriverContext } from './driver-context.types.js';
import type { AuthenticatedUser } from '../../auth/guards/auth-types.js';
import type { FastifyRequest } from 'fastify';

interface RequestWithDriverContext extends FastifyRequest {
  user?: AuthenticatedUser;
  [DRIVER_CONTEXT_REQUEST_KEY]?: DriverContext;
}

@Injectable()
export class DriverContextGuard implements CanActivate {
  constructor(private readonly drivers: DriversRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithDriverContext>();

    const user = req.user;
    if (user === undefined) {
      throw new AuthError(
        'UNAUTHENTICATED',
        'driver route reached without an authenticated principal',
      );
    }

    if (user.role !== 'driver') {
      throw new ForbiddenError('Authenticated principal is not a driver', {
        actorRole: user.role,
      });
    }

    const driver = await this.drivers.findByUserId(user.userId);
    if (driver === null) {
      throw new ForbiddenError('No driver profile exists for the authenticated user', {
        userId: user.userId,
      });
    }

    req[DRIVER_CONTEXT_REQUEST_KEY] = {
      driverId: driver.id,
      userId: user.userId,
      currentStatus: driver.currentStatus,
      currentOrderId: driver.currentOrderId,
    };
    return true;
  }
}
