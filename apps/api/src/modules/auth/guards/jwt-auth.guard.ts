/**
 * Global JWT auth guard.
 *
 * Behaviour:
 *   1. Reads the @Public metadata via Reflector — public routes (health,
 *      register, login, refresh, kyc webhook) skip the guard entirely.
 *   2. Pulls the Bearer token off the Authorization header.
 *   3. Verifies it through JwtService.verifyAccessToken — that call already
 *      raises typed AuthError variants for expired / invalid / wrong-alg
 *      tokens, which the global filter renders as 401 ErrorEnvelope.
 *   4. Attaches `{ userId, sessionId, role }` to `req.user` for the
 *      @CurrentUser decorator and downstream guards.
 *
 * Bind this guard globally in `main.ts` via `app.useGlobalGuards(...)` so
 * deny-by-default applies: any new route is authenticated unless it
 * carries @Public.
 */
import { AuthError } from '@dankdash/types';
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator.js';
import { JwtService } from '../jwt/jwt.service.js';
import type { AuthenticatedUser } from './auth-types.js';
import type { UserRoleDto } from '../dto/user-summary.dto.js';
import type { FastifyRequest } from 'fastify';

const VALID_ROLES: ReadonlySet<UserRoleDto> = new Set<UserRoleDto>([
  'customer',
  'budtender',
  'manager',
  'owner',
  'driver',
  'admin',
  'superadmin',
]);

interface RequestWithUser extends FastifyRequest {
  user?: AuthenticatedUser;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const req = context.switchToHttp().getRequest<RequestWithUser>();
    const token = extractBearerToken(req);
    if (token === null) {
      throw new AuthError('UNAUTHENTICATED', 'missing or malformed Authorization header');
    }

    const claims = this.jwt.verifyAccessToken(token);
    if (!VALID_ROLES.has(claims.role as UserRoleDto)) {
      // Defensive: the access-token claim's role must match the enum we
      // ship to clients. A stale token issued before a role was retired
      // (or a key compromise minting bogus tokens) would land here.
      throw new AuthError('TOKEN_INVALID', 'access token carries an unrecognised role', {
        role: claims.role,
      });
    }

    req.user = {
      userId: claims.sub,
      sessionId: claims.sid,
      role: claims.role as UserRoleDto,
    };
    return true;
  }
}

function extractBearerToken(req: FastifyRequest): string | null {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/u.exec(header);
  if (match === null) return null;
  const token = match[1]?.trim();
  return token === undefined || token.length === 0 ? null : token;
}
