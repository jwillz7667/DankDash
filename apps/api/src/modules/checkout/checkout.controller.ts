/**
 * Checkout HTTP surface — `POST /v1/carts/:id/checkout`.
 *
 * Mounted under `/v1/carts/:id/checkout` (NOT `/v1/checkout`) for two
 * reasons:
 *
 *   1. The cart id is the natural conversation key — every prior cart
 *      surface (POST /, GET /:id, POST /:id/items, POST /:id/validate)
 *      is rooted at the same id, and the iOS client builds the URL from
 *      the cart that it just validated. A standalone `/v1/checkout`
 *      route would require re-passing the cart id in the body, which is
 *      duplicative and creates a probe vector (cart id in body vs
 *      principal in JWT mismatch).
 *
 *   2. The 410-Gone behaviour on an expired cart is most natural at the
 *      cart-rooted URL. A consumer reading `Cart not found` (404) vs
 *      `Cart expired` (410) at the same URL prefix is a clean error
 *      surface.
 *
 * Roles: customer is the primary; admin/superadmin retain access for
 * support tooling that may need to checkout on behalf of a user. Staff
 * (budtender/manager/owner/driver) are excluded — they have no consumer
 * cart and should never trigger a checkout. The guard stack matches the
 * cart controller's: JwtAuthGuard (global) → RolesGuard.
 *
 * Rate limit: 12 per minute per user is loose enough to absorb a
 * frenzied retry sequence after a 5xx and tight enough to bound the
 * checkout-spam attack surface. A real customer rarely checks out more
 * than once per minute; the limit only bites pathological cases.
 *
 * The endpoint always responds 201 on success (an order was created).
 * 422 maps to a compliance failure or an empty cart; 409 to an inventory
 * shortfall; 410 to an expired cart; 404 to an unowned cart or address.
 * All five are typed `DomainError` subclasses the global filter knows
 * how to map.
 */
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { CheckoutService } from './checkout.service.js';
import { CheckoutRequestDto, type CheckoutResponse } from './dto/index.js';
import type { AuthenticatedUser } from '../auth/guards/auth-types.js';

@Controller('carts/:id/checkout')
@UseGuards(RolesGuard)
@Roles('customer', 'admin', 'superadmin')
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'cart-checkout', tracker: 'user', limit: 12, windowMs: 60_000 })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) cartId: string,
    @Body() body: CheckoutRequestDto,
  ): Promise<CheckoutResponse> {
    return this.checkout.checkout(user.userId, cartId, body);
  }
}
