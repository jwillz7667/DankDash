/**
 * /v1/payment-methods HTTP surface — consumer payment-method management.
 *
 *   GET    /v1/payment-methods                — list the caller's methods
 *   POST   /v1/payment-methods/aeropay/link   — start a hosted-bank-link
 *                                                 session and return the URL
 *                                                 the iOS Safari sheet opens
 *   DELETE /v1/payment-methods/:id            — soft-delete a method
 *
 * Guards: JwtAuthGuard (global) + RolesGuard. Customers manage their own
 * methods; admin/superadmin retain access for support tooling (e.g.
 * clearing a stuck `pending` row on a user's behalf). Staff roles
 * (budtender/manager/owner/driver) are intentionally excluded — they do
 * not have consumer payment methods. The vendor-side payouts surface
 * (Phase 6.6) ships on its own controller.
 *
 * Rate limits are scoped per-user (the JWT principal) since a single
 * customer hammering link/delete is the threat shape — not a single IP
 * across accounts.
 *
 * The Aeropay webhook is intentionally NOT on this controller: webhooks
 * are public (signature-authenticated) and the body must be read raw,
 * which requires a different request shape. It lives in
 * `aeropay-webhook.controller.ts`.
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
  UseGuards,
} from '@nestjs/common';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { LinkAeropayRequestDto, SetDefaultPaymentMethodRequestDto } from './dto/index.js';
import { PaymentMethodsService } from './payment-methods.service.js';
import type {
  LinkAeropayResponse,
  ListPaymentMethodsResponse,
  PaymentMethodEnvelopeResponse,
} from './dto/index.js';
import type { AuthenticatedUser } from '../auth/guards/auth-types.js';

@Controller('payment-methods')
@UseGuards(RolesGuard)
@Roles('customer', 'admin', 'superadmin')
export class PaymentMethodsController {
  constructor(private readonly service: PaymentMethodsService) {}

  @Get()
  @RateLimit({ name: 'payment-methods-list', tracker: 'user', limit: 120, windowMs: 60_000 })
  list(@CurrentUser() user: AuthenticatedUser): Promise<ListPaymentMethodsResponse> {
    return this.service.list(user.userId);
  }

  @Post('aeropay/link')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'payment-methods-link', tracker: 'user', limit: 10, windowMs: 60_000 })
  link(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: LinkAeropayRequestDto,
  ): Promise<LinkAeropayResponse> {
    return this.service.linkAeropay(user.userId, body.returnUrl);
  }

  @Patch(':id')
  @RateLimit({ name: 'payment-methods-set-default', tracker: 'user', limit: 30, windowMs: 60_000 })
  setDefault(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    // Body is validated for shape (`isDefault: true`) by the Zod DTO; the only
    // mutation this route exposes is default promotion, so the id + principal
    // are all the service needs.
    @Body() _body: SetDefaultPaymentMethodRequestDto,
  ): Promise<PaymentMethodEnvelopeResponse> {
    return this.service.setDefault(user.userId, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit({ name: 'payment-methods-delete', tracker: 'user', limit: 30, windowMs: 60_000 })
  delete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    return this.service.delete(user.userId, id);
  }
}
