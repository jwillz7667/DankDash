/**
 * /v1/driver/orders HTTP surface — driver app's view of (and writes
 * against) the order currently in their hands.
 *
 *   GET  /v1/driver/orders/:id                   — full handoff bundle
 *   POST /v1/driver/orders/:id/pickup-confirm    — driver_assigned → en_route_pickup
 *   POST /v1/driver/orders/:id/delivery-confirm  — *_dropoff → delivered (ID-scan gated)
 *
 * Guards: JwtAuthGuard binds globally in main.ts so the request already
 * carries `req.user`. RolesGuard narrows access — `driver` only.
 * Consumer (`customer`) reads its own orders via /v1/orders; vendor
 * (`budtender` / `manager` / `owner`) reads via the portal's own surface
 * scoped through dispensary RLS. Neither role reaches this controller.
 *
 * Cross-driver reads return 404 by construction (the service pairs
 * `(orderId, driverUserId)` in the WHERE) — same response shape as
 * missing, so a probe cannot distinguish ownership-fail from
 * existence-fail.
 *
 * Rate limits are sized for the foreground polling fallback and the
 * occasional retry under flaky cellular. 240/min on the GET leaves
 * plenty of headroom over the 6/min the polling actually does; the two
 * POST endpoints are bursty around the pickup / dropoff moment and
 * 60/min is generous for the worst-case "tap, get 5xx, retry, retry"
 * pattern without leaving a brute-force window open.
 */
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { RateLimit } from '../../../common/decorators/rate-limit.decorator.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import {
  DriverDeliveryConfirmRequestDto,
  DriverPickupConfirmRequestDto,
  type DriverOrderDetailResponse,
} from '../dto/index.js';
import { DriverOrdersService } from '../services/driver-orders.service.js';
import type { AuthenticatedUser } from '../../auth/guards/auth-types.js';

@Controller('driver/orders')
@UseGuards(RolesGuard)
@Roles('driver')
export class DriverOrdersController {
  constructor(private readonly driverOrders: DriverOrdersService) {}

  @Get(':id')
  @RateLimit({ name: 'driver-order-detail', tracker: 'user', limit: 240, windowMs: 60_000 })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<DriverOrderDetailResponse> {
    return this.driverOrders.getForDriver(user.userId, id);
  }

  @Post(':id/pickup-confirm')
  @RateLimit({ name: 'driver-pickup-confirm', tracker: 'user', limit: 60, windowMs: 60_000 })
  pickupConfirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: DriverPickupConfirmRequestDto,
  ): Promise<DriverOrderDetailResponse> {
    return this.driverOrders.confirmPickup(user.userId, id, body);
  }

  @Post(':id/delivery-confirm')
  @RateLimit({ name: 'driver-delivery-confirm', tracker: 'user', limit: 60, windowMs: 60_000 })
  deliveryConfirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: DriverDeliveryConfirmRequestDto,
  ): Promise<DriverOrderDetailResponse> {
    return this.driverOrders.confirmDelivery(user.userId, id, body);
  }
}
