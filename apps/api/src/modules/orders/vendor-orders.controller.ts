/**
 * /v1/vendor/orders/:id/{accept,reject,prepped,ready,handoff} — vendor
 * lifecycle controls. Each endpoint funnels through OrderTransitionService;
 * the controller's job is parsing the path, attaching the actor, and
 * projecting the response.
 *
 * Guards (in order): JwtAuthGuard (global) → VendorContextGuard (reads
 * X-Dispensary-Id, verifies active staff membership) → RolesGuard (gates
 * which dispensary staff roles may hit the route). The roles allow-list
 * is generous (budtender/manager/owner) because the order surface is the
 * everyday vendor workflow; the admin global role is also allowed for
 * support tooling.
 *
 * Rate limits are per-user and intentionally permissive — a busy
 * dispensary realistically accepts/preps/marks-ready dozens of orders a
 * minute during peak. The throttle is there to absorb a stuck client
 * hammering the same endpoint, not to gate legitimate use.
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
import { RejectOrderRequestDto, type TransitionResponse } from './dto/index.js';
import { OrderTransitionService } from './order-transition.service.js';
import { OrdersService } from './orders.service.js';
import type { VendorContext } from '../listings/vendor/vendor-context.types.js';

@Controller('vendor/orders')
@UseGuards(VendorContextGuard, RolesGuard)
@Roles('budtender', 'manager', 'owner', 'admin', 'superadmin')
export class VendorOrdersController {
  constructor(
    private readonly transitions: OrderTransitionService,
    private readonly orders: OrdersService,
  ) {}

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'vendor-order-accept', tracker: 'user', limit: 240, windowMs: 60_000 })
  async accept(
    @CurrentDispensary() ctx: VendorContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<TransitionResponse> {
    return this.fire(ctx, id, 'VENDOR_ACCEPT');
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'vendor-order-reject', tracker: 'user', limit: 60, windowMs: 60_000 })
  async reject(
    @CurrentDispensary() ctx: VendorContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: RejectOrderRequestDto,
  ): Promise<TransitionResponse> {
    return this.fire(ctx, id, 'VENDOR_REJECT', body.reason);
  }

  @Post(':id/prepped')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'vendor-order-prepped', tracker: 'user', limit: 240, windowMs: 60_000 })
  async prepped(
    @CurrentDispensary() ctx: VendorContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<TransitionResponse> {
    return this.fire(ctx, id, 'VENDOR_PREPPING');
  }

  @Post(':id/ready')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'vendor-order-ready', tracker: 'user', limit: 240, windowMs: 60_000 })
  async ready(
    @CurrentDispensary() ctx: VendorContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<TransitionResponse> {
    return this.fire(ctx, id, 'VENDOR_READY');
  }

  /**
   * Vendor confirms the driver took possession of the order. Mapped onto
   * DRIVER_PICKED_UP — the driver's own /v1/driver/orders/:id/picked-up
   * endpoint (Phase 8) also fires the same event from the driver side;
   * either path works because the row lock + state machine guarantee
   * exactly one wins.
   */
  @Post(':id/handoff')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'vendor-order-handoff', tracker: 'user', limit: 240, windowMs: 60_000 })
  async handoff(
    @CurrentDispensary() ctx: VendorContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<TransitionResponse> {
    return this.fire(ctx, id, 'DRIVER_PICKED_UP');
  }

  private async fire(
    ctx: VendorContext,
    orderId: string,
    event:
      | 'VENDOR_ACCEPT'
      | 'VENDOR_REJECT'
      | 'VENDOR_PREPPING'
      | 'VENDOR_READY'
      | 'DRIVER_PICKED_UP',
    reason?: string,
  ): Promise<TransitionResponse> {
    // Pre-check ownership so vendor A cannot probe for vendor B's order
    // IDs via the transition surface; surfaces 404 not 403 (same as the
    // read endpoint).
    await this.orders.findForDispensary(ctx.dispensaryId, orderId);

    const result = await this.transitions.transition({
      orderId,
      event,
      actor: { userId: ctx.userId, role: 'vendor', dispensaryId: ctx.dispensaryId },
      ...(reason !== undefined ? { reason } : {}),
    });
    return {
      id: result.orderId,
      status: result.toStatus,
      statusChangedAt: new Date().toISOString(),
    };
  }
}
