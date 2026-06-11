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
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { CurrentDispensary } from '../listings/vendor/current-dispensary.decorator.js';
import { VendorContextGuard } from '../listings/vendor/vendor-context.guard.js';
import {
  ListVendorOrdersQueryDto,
  RejectOrderRequestDto,
  type ListVendorQueueResponse,
  type OrderResponse,
  type TransitionResponse,
} from './dto/index.js';
import { OrderTransitionService } from './order-transition.service.js';
import { projectOrder, projectVendorQueueOrder } from './order.projection.js';
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

  /**
   * Live queue feed for the portal kanban. The default status set is
   * the six "active vendor work" statuses; callers can narrow via
   * `?statuses=placed,accepted`. Ordered oldest-first so the longest-
   * waiting order in each column floats to the top.
   *
   * The limit is generous (200 default, 200 max) because the portal
   * paints all four columns from a single response — a busy dispensary
   * during peak can legitimately have 100+ active orders.
   */
  @Get()
  @RateLimit({ name: 'vendor-orders-list', tracker: 'user', limit: 120, windowMs: 60_000 })
  async list(
    @CurrentDispensary() ctx: VendorContext,
    @Query() query: ListVendorOrdersQueryDto,
  ): Promise<ListVendorQueueResponse> {
    const rows = await this.orders.listForDispensaryQueue(
      ctx.dispensaryId,
      query.statuses,
      query.limit,
    );
    return { orders: rows.map(projectVendorQueueOrder) };
  }

  /**
   * Single-order detail for the drawer view. Returns the canonical
   * {@link OrderResponse} (same shape the customer-side surfaces use)
   * since the drawer renders timestamps, ratings, and the full money
   * breakdown. Ownership pre-check surfaces 404 not 403 on a
   * cross-tenant probe — same posture as the transition endpoints.
   */
  @Get(':id')
  @RateLimit({ name: 'vendor-orders-get', tracker: 'user', limit: 240, windowMs: 60_000 })
  async get(
    @CurrentDispensary() ctx: VendorContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<OrderResponse> {
    const order = await this.orders.findForDispensary(ctx.dispensaryId, id);
    return projectOrder(order);
  }

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
   * DRIVER_PICKED_UP, valid only from `en_route_pickup` (the driver has
   * confirmed they are at the store). This is the production path to
   * `picked_up` — the driver app deliberately has no picked-up endpoint;
   * it sits in "awaiting handoff" until this transition lands and reaches
   * it via realtime or its 15s poll.
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
