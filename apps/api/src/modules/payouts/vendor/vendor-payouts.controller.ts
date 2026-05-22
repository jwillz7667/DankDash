/**
 * /v1/vendor/payouts HTTP surface (Phase 15.3).
 *
 *   GET /v1/vendor/payouts        — list payouts (latest 50)
 *   GET /v1/vendor/payouts/:id    — single payout + constituent orders
 *
 * Guards mirror the rest of /v1/vendor:
 *
 *   1. Global JwtAuthGuard
 *   2. VendorContextGuard (attaches the typed VendorContext)
 *   3. RolesGuard (narrowed to manager+; budtenders don't see payouts)
 *
 * Budtenders are excluded by design — payouts are financial data that
 * sits behind `manager / owner / admin / superadmin`, matching the role
 * gate on the portal sidebar in Phase 13. The shared `RolesGuard` rejects
 * a budtender principal before this controller ever sees the request.
 *
 * Rate limits sized for browsing: each page renders once per navigation
 * and a power user might page through ~10 payouts per minute. 60 / min
 * per principal is plenty of headroom without sheltering a runaway
 * client that hammers the detail endpoint.
 */
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { RateLimit } from '../../../common/decorators/rate-limit.decorator.js';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { CurrentDispensary } from '../../listings/vendor/current-dispensary.decorator.js';
import { VendorContextGuard } from '../../listings/vendor/vendor-context.guard.js';
import { VendorPayoutsService } from './vendor-payouts.service.js';
import type { VendorPayoutDetailResponse, VendorPayoutListResponse } from './dto/index.js';
import type { VendorContext } from '../../listings/vendor/vendor-context.types.js';

@Controller('vendor/payouts')
@UseGuards(VendorContextGuard, RolesGuard)
@Roles('manager', 'owner', 'admin', 'superadmin')
export class VendorPayoutsController {
  constructor(private readonly payouts: VendorPayoutsService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'vendor-payouts-list', tracker: 'user', limit: 60, windowMs: 60_000 })
  list(@CurrentDispensary() ctx: VendorContext): Promise<VendorPayoutListResponse> {
    return this.payouts.list(ctx);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'vendor-payouts-detail', tracker: 'user', limit: 60, windowMs: 60_000 })
  findById(
    @CurrentDispensary() ctx: VendorContext,
    @Param('id', new ParseUUIDPipe()) payoutId: string,
  ): Promise<VendorPayoutDetailResponse> {
    return this.payouts.findById(ctx, payoutId);
  }
}
