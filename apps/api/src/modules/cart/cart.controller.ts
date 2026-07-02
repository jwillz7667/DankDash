/**
 * /v1/carts HTTP surface — consumer cart CRUD.
 *
 *   POST   /v1/carts                           — create-or-get cart for dispensary
 *   GET    /v1/carts/:id                       — read cart (touches TTL)
 *   POST   /v1/carts/:id/items                 — add or increment a line
 *   PATCH  /v1/carts/:id/items/:itemId         — update line quantity (0 = remove)
 *   DELETE /v1/carts/:id/items/:itemId         — remove a line
 *   POST   /v1/carts/:id/validate              — compliance preview (read-only)
 *   DELETE /v1/carts/:id                       — drop the cart entirely
 *
 * Guards stack as: JwtAuthGuard (global) → RolesGuard. The vendor side
 * uses VendorContextGuard to pin a dispensary; the consumer side does
 * not — carts are user-owned, the dispensary context lives on the cart
 * row itself (POST body for creation, foreign key for the rest).
 *
 * Roles: customer is the primary surface; admin/superadmin retain
 * access for support tooling that needs to inspect or clear a stuck
 * cart on behalf of a user. budtender/manager/owner/driver are
 * deliberately excluded — staff users do not have a consumer cart.
 *
 * Rate limits are scoped per-user (the JWT principal): a single user
 * spamming POST item is the threat shape, not a single IP across
 * accounts. Numbers are loose for now — cart actions are interactive
 * and a user genuinely poking the UI can hit a couple per second.
 *
 * Successful responses always return the projected `CartResponse`
 * (with refreshed `expiresAt`) so the iOS client never needs a
 * follow-up GET after a mutation. The exception is DELETE /:id which
 * returns 204 — the cart is gone, there is nothing to project.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { CartService } from './cart.service.js';
import {
  AddCartItemRequestDto,
  ApplyPromoRequestDto,
  CreateCartRequestDto,
  PatchCartItemRequestDto,
  ValidateCartQueryDto,
  type CartResponse,
  type ValidateCartResponse,
} from './dto/index.js';
import type { AuthenticatedUser } from '../auth/guards/auth-types.js';

@Controller('carts')
@UseGuards(RolesGuard)
@Roles('customer', 'admin', 'superadmin')
export class CartController {
  constructor(private readonly carts: CartService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'cart-create', tracker: 'user', limit: 60, windowMs: 60_000 })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateCartRequestDto,
  ): Promise<CartResponse> {
    return this.carts.createOrGet(user.userId, body);
  }

  @Get(':id')
  @RateLimit({ name: 'cart-read', tracker: 'user', limit: 240, windowMs: 60_000 })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CartResponse> {
    return this.carts.findForUser(user.userId, id);
  }

  @Post(':id/items')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'cart-add-item', tracker: 'user', limit: 240, windowMs: 60_000 })
  addItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: AddCartItemRequestDto,
  ): Promise<CartResponse> {
    return this.carts.addItem(user.userId, id, body);
  }

  @Patch(':id/items/:itemId')
  @RateLimit({ name: 'cart-patch-item', tracker: 'user', limit: 240, windowMs: 60_000 })
  patchItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() body: PatchCartItemRequestDto,
  ): Promise<CartResponse> {
    return this.carts.patchItem(user.userId, id, itemId, body);
  }

  @Delete(':id/items/:itemId')
  @RateLimit({ name: 'cart-remove-item', tracker: 'user', limit: 240, windowMs: 60_000 })
  removeItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
  ): Promise<CartResponse> {
    return this.carts.removeItem(user.userId, id, itemId);
  }

  /**
   * Compliance preview. POST shape (not GET) because Nest's route
   * matcher pairs cleanly with the body-less POST decorator and the
   * iOS client builds the request as a POST with a query payload; the
   * operation is conceptually a query, never mutates state, and is
   * idempotent.
   *
   * 200 OK on a passing OR failing evaluation — the response carries
   * the `passed` boolean and detailed `rules[]`. The 422 happens at
   * checkout (5.3), not here; the preview's job is to tell the client
   * exactly why a checkout would fail so the UI can guide the fix.
   *
   * Loose rate limit — the iOS client may call this on every add/
   * remove/quantity tap (240/min = 4/s sustained), which is well
   * within real interaction. Heavier surges land at the IP-level
   * global rate limit upstream.
   */
  @Post(':id/validate')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'cart-validate', tracker: 'user', limit: 240, windowMs: 60_000 })
  validate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: ValidateCartQueryDto,
  ): Promise<ValidateCartResponse> {
    return this.carts.validate(user.userId, id, query.deliveryAddressId);
  }

  /**
   * Apply a promo code. Returns the cart with the live discount preview. The
   * full validation (including redemption caps) runs here; only a valid promo
   * is attached. Checkout re-validates authoritatively.
   */
  @Post(':id/promo')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'cart-apply-promo', tracker: 'user', limit: 60, windowMs: 60_000 })
  applyPromo(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ApplyPromoRequestDto,
  ): Promise<CartResponse> {
    return this.carts.applyPromo(user.userId, id, body.code);
  }

  @Delete(':id/promo')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'cart-remove-promo', tracker: 'user', limit: 60, windowMs: 60_000 })
  removePromo(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CartResponse> {
    return this.carts.removePromo(user.userId, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit({ name: 'cart-delete', tracker: 'user', limit: 60, windowMs: 60_000 })
  delete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    return this.carts.delete(user.userId, id);
  }
}
