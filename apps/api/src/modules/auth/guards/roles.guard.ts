/**
 * Role allow-list guard.
 *
 * Reads `@Roles(...)` metadata via Reflector and compares against
 * `req.user.role` (attached by JwtAuthGuard). Methods without the
 * decorator pass through — RolesGuard is opt-in per route, unlike
 * JwtAuthGuard which is global.
 *
 * Throws ForbiddenError (403) when the user is authenticated but holds a
 * role outside the allow-list. AuthError (401) is reserved for the
 * "couldn't verify the token at all" case, which JwtAuthGuard owns.
 */
import { ForbiddenError } from '@dankdash/types';
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator.js';
import type { AuthenticatedUser } from './auth-types.js';
import type { UserRoleDto } from '../dto/user-summary.dto.js';
import type { FastifyRequest } from 'fastify';

interface RequestWithUser extends FastifyRequest {
  readonly user?: AuthenticatedUser;
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<readonly UserRoleDto[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (required === undefined || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<RequestWithUser>();
    const user = req.user;
    if (user === undefined) {
      // RolesGuard runs after JwtAuthGuard, so a missing user here means
      // the route was @Public yet still carries @Roles — that combination
      // is a misconfiguration in the controller.
      throw new ForbiddenError('@Roles set on a public route — no principal to check', {
        required,
      });
    }
    if (!required.includes(user.role)) {
      throw new ForbiddenError(`role '${user.role}' is not permitted on this route`, {
        required,
        actual: user.role,
      });
    }
    return true;
  }
}
