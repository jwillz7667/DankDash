/**
 * /v1/vendor/orders/:id/refund HTTP surface — vendor-initiated refunds.
 *
 * Guards stack:
 *   1. Global JwtAuthGuard — authenticates the principal.
 *   2. VendorContextGuard  — requires `X-Dispensary-Id`, verifies the
 *      principal is an active staff member of that dispensary, and
 *      attaches a VendorContext.
 *   3. RolesGuard          — narrows to vendor-side roles plus admins
 *      (admins retain access for support tooling, identical to the
 *      vendor-listings controller).
 *
 * The service guarantees the order belongs to the vendor's dispensary
 * (404 on mismatch); the guard only proves the principal is on the
 * dispensary's staff, not that any given order is theirs.
 *
 * Rate limit: tighter than the listing endpoints because every refund
 * issues a real Aeropay reverse-ACH or queues an admin approval. A
 * single budtender hitting 60 refunds/min is almost certainly a UI
 * loop, not legitimate vendor activity.
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
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { CurrentDispensary } from '../listings/vendor/current-dispensary.decorator.js';
import { VendorContextGuard } from '../listings/vendor/vendor-context.guard.js';
import { InitiateRefundRequestDto } from './dto/index.js';
import { RefundsService } from './refunds.service.js';
import type { RefundEnvelopeResponse } from './dto/index.js';
import type { VendorContext } from '../listings/vendor/vendor-context.types.js';

@Controller('vendor/orders')
@UseGuards(VendorContextGuard, RolesGuard)
@Roles('budtender', 'manager', 'owner', 'admin', 'superadmin')
export class VendorRefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Post(':id/refund')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'vendor-refund-initiate', tracker: 'user', limit: 20, windowMs: 60_000 })
  async initiate(
    @CurrentDispensary() ctx: VendorContext,
    @Param('id', new ParseUUIDPipe()) orderId: string,
    @Body() body: InitiateRefundRequestDto,
  ): Promise<RefundEnvelopeResponse> {
    const refund = await this.refunds.initiate(ctx, orderId, body);
    return { refund };
  }
}
