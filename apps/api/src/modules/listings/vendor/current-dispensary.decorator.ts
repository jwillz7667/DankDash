/**
 * Pulls the VendorContext attached by VendorContextGuard off the request.
 *
 * Usage:
 *   @UseGuards(VendorContextGuard)
 *   @Get('listings')
 *   list(@CurrentDispensary() ctx: VendorContext): Promise<...> { ... }
 *
 * Mirrors the @CurrentUser pattern in modules/auth/decorators — keeps the
 * controller layer free of header parsing and request-shape knowledge.
 *
 * Throws AuthError UNAUTHENTICATED when reached without the guard having
 * attached a context. That can only happen if the decorator is used on a
 * route that omits @UseGuards(VendorContextGuard) — controller mistake,
 * not a client-side condition.
 */
import { AuthError } from '@dankdash/types';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { VENDOR_CONTEXT_REQUEST_KEY, type VendorContext } from './vendor-context.types.js';
import type { FastifyRequest } from 'fastify';

interface RequestWithContext extends FastifyRequest {
  readonly [VENDOR_CONTEXT_REQUEST_KEY]?: VendorContext;
}

export const CurrentDispensary = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): VendorContext => {
    const req = ctx.switchToHttp().getRequest<RequestWithContext>();
    const vendor = req[VENDOR_CONTEXT_REQUEST_KEY];
    if (vendor === undefined) {
      throw new AuthError(
        'UNAUTHENTICATED',
        '@CurrentDispensary used on a route without VendorContextGuard',
      );
    }
    return vendor;
  },
);
