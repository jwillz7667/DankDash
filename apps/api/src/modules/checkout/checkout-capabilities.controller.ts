/**
 * Checkout capabilities HTTP surface — `GET /v1/checkout/capabilities`.
 *
 * Deliberately a *separate* controller from `CheckoutController` (which is
 * rooted at `/v1/carts/:id/checkout`): this probe is cart-independent — the
 * client asks "may I place an order in-app at all?" before it even has a
 * validated cart to checkout. Mounting it at `/v1/checkout/capabilities`
 * keeps it off the cart-id-scoped path and gives it a stable, cacheable
 * URL the app can hit on the cart screen's first render.
 *
 * Same guard stack and roles as the checkout itself (JwtAuthGuard global →
 * RolesGuard; customer is the consumer, admin/superadmin for support
 * tooling): the answer is only meaningful to a principal who could
 * actually checkout, and we don't leak the server's run-mode to staff or
 * anonymous callers.
 *
 * Rate limit is generous (60/min/user) — the client polls this on screen
 * appearance and it's a pure in-memory read, but we still bound it so a
 * misbehaving client can't hammer it unbounded.
 */
import { Controller, Get, UseGuards } from '@nestjs/common';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { CheckoutService } from './checkout.service.js';
import type { CheckoutCapabilitiesResponse } from './dto/index.js';

@Controller('checkout')
@UseGuards(RolesGuard)
@Roles('customer', 'admin', 'superadmin')
export class CheckoutCapabilitiesController {
  constructor(private readonly checkout: CheckoutService) {}

  @Get('capabilities')
  @RateLimit({ name: 'checkout-capabilities', tracker: 'user', limit: 60, windowMs: 60_000 })
  getCapabilities(): CheckoutCapabilitiesResponse {
    return this.checkout.getCapabilities();
  }
}
