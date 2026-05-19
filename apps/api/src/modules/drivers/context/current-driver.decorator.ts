/**
 * Pulls the DriverContext attached by DriverContextGuard off the request.
 *
 *   @UseGuards(DriverContextGuard)
 *   @Post('shift/start')
 *   start(@CurrentDriver() ctx: DriverContext): Promise<...> { ... }
 *
 * Mirrors @CurrentDispensary — keeps controllers free of header parsing
 * and request-shape knowledge. Throws AuthError UNAUTHENTICATED when
 * reached without the guard having attached a context (controller
 * coding mistake, not a client-side condition).
 */
import { AuthError } from '@dankdash/types';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { DRIVER_CONTEXT_REQUEST_KEY, type DriverContext } from './driver-context.types.js';
import type { FastifyRequest } from 'fastify';

interface RequestWithContext extends FastifyRequest {
  readonly [DRIVER_CONTEXT_REQUEST_KEY]?: DriverContext;
}

export const CurrentDriver = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): DriverContext => {
    const req = ctx.switchToHttp().getRequest<RequestWithContext>();
    const driver = req[DRIVER_CONTEXT_REQUEST_KEY];
    if (driver === undefined) {
      throw new AuthError(
        'UNAUTHENTICATED',
        '@CurrentDriver used on a route without DriverContextGuard',
      );
    }
    return driver;
  },
);
