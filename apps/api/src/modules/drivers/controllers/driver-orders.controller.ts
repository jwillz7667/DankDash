/**
 * /v1/driver/orders HTTP surface — driver app's view of a single order.
 *
 *   GET /v1/driver/orders/:id   — full handoff bundle (order header +
 *                                  items + timeline + dispensary +
 *                                  dropoff snapshot + id-scan state +
 *                                  initialed customer summary).
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
 * Rate limit is per-user and sized for the foreground polling fallback
 * (when the `/driver` Socket.io namespace isn't ready, the iOS active-
 * route screen refreshes the detail every 10 s while driving). 240 / min
 * leaves plenty of headroom over the 6 / min the polling actually does.
 */
import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { RateLimit } from '../../../common/decorators/rate-limit.decorator.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { type DriverOrderDetailResponse } from '../dto/index.js';
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
}
