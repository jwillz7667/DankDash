/**
 * Marks a route as not requiring authentication. The JwtAuthGuard (added
 * with the auth module) reads this metadata via Reflector before deciding
 * whether to challenge the request.
 *
 * Deny-by-default is preserved at the guard layer — omitting @Public means
 * the route requires a valid access token.
 */
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:isPublic';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
