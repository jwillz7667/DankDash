/**
 * Pulls the authenticated principal off the request. The principal is
 * attached by JwtAuthGuard as `req.user` after a successful access-token
 * verification — see jwt-auth.guard.ts for the shape.
 *
 * Usage:
 *   @Get('me')
 *   me(@CurrentUser() user: AuthenticatedUser): MeResponse { ... }
 *
 * Throws AuthError UNAUTHENTICATED when the route is reachable without
 * authentication (i.e. the guard was bypassed, typically because of a
 * @Public decorator) but a handler still requested the user — that's a
 * controller-coding mistake, not a client-side condition.
 */
import { AuthError } from '@dankdash/types';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from '../guards/auth-types.js';
import type { FastifyRequest } from 'fastify';

interface RequestWithUser extends FastifyRequest {
  readonly user?: AuthenticatedUser;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const req = ctx.switchToHttp().getRequest<RequestWithUser>();
    if (req.user === undefined) {
      throw new AuthError(
        'UNAUTHENTICATED',
        '@CurrentUser used on a route with no authenticated principal',
      );
    }
    return req.user;
  },
);
