/**
 * /v1/vendor/payouts/bank-account HTTP surface — dispensary payout bank
 * linking.
 *
 *   POST /v1/vendor/payouts/bank-account/link  — start an Aeropay hosted
 *                                                 bank-link session; returns
 *                                                 the URL the portal opens
 *   GET  /v1/vendor/payouts/bank-account       — read link status (boolean)
 *
 * Guard stack mirrors the rest of /v1/vendor (and the read-only
 * VendorPayoutsController this sits alongside):
 *
 *   1. Global JwtAuthGuard        — authenticates the principal.
 *   2. VendorContextGuard         — requires `X-Dispensary-Id`, verifies the
 *                                    principal is active staff, attaches the
 *                                    VendorContext.
 *   3. RolesGuard @Roles(manager+) — budtenders don't manage payout banking;
 *                                    financial data sits behind manager /
 *                                    owner / admin / superadmin, identical to
 *                                    the payouts read surface.
 *
 * The static `bank-account` / `bank-account/link` paths are deeper than the
 * `vendor/payouts/:id` param route on VendorPayoutsController; Fastify's
 * router resolves the static segments first, so there is no collision.
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { CurrentDispensary } from '../listings/vendor/current-dispensary.decorator.js';
import { VendorContextGuard } from '../listings/vendor/vendor-context.guard.js';
import { DispensaryBankLinkService } from './dispensary-bank-link.service.js';
import { StartDispensaryBankLinkRequestDto } from './dto/index.js';
import type {
  DispensaryBankAccountStatusResponse,
  StartDispensaryBankLinkResponse,
} from './dto/index.js';
import type { VendorContext } from '../listings/vendor/vendor-context.types.js';

@Controller('vendor/payouts/bank-account')
@UseGuards(VendorContextGuard, RolesGuard)
@Roles('manager', 'owner', 'admin', 'superadmin')
export class VendorPayoutAccountController {
  constructor(private readonly service: DispensaryBankLinkService) {}

  @Post('link')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'vendor-payout-bank-link', tracker: 'user', limit: 10, windowMs: 60_000 })
  startLink(
    @CurrentDispensary() ctx: VendorContext,
    @Body() body: StartDispensaryBankLinkRequestDto,
  ): Promise<StartDispensaryBankLinkResponse> {
    return this.service.startLink(ctx, body.returnUrl);
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'vendor-payout-bank-status', tracker: 'user', limit: 60, windowMs: 60_000 })
  getStatus(@CurrentDispensary() ctx: VendorContext): Promise<DispensaryBankAccountStatusResponse> {
    return this.service.getStatus(ctx);
  }
}
