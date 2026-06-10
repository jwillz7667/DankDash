/**
 * /v1/driver/orders HTTP surface — driver app's view of (and writes
 * against) the order currently in their hands.
 *
 *   GET  /v1/driver/orders/:id                   — full handoff bundle
 *   POST /v1/driver/orders/:id/pickup-confirm    — driver_assigned → en_route_pickup
 *   POST /v1/driver/orders/:id/cancel            — driver_assigned|en_route_pickup → awaiting_driver
 *   POST /v1/driver/orders/:id/depart            — picked_up → en_route_dropoff
 *   POST /v1/driver/orders/:id/arrive            — en_route_dropoff → arrived_at_dropoff
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
  DriverIdScanResultRequestDto,
  type DriverIdScanSessionResponse,
} from '../../identity-verification/dto/index.js';
import {
  DriverArriveRequestDto,
  DriverCancelDeliveryRequestDto,
  DriverDeliveryConfirmRequestDto,
  DriverDepartRequestDto,
  DriverPickupConfirmRequestDto,
  type DriverCancelDeliveryResponse,
  type DriverOrderDetailResponse,
} from '../dto/index.js';
import { DriverIdScanService } from '../services/driver-id-scan.service.js';
import { DriverOrdersService } from '../services/driver-orders.service.js';
import type { AuthenticatedUser } from '../../auth/guards/auth-types.js';

@Controller('driver/orders')
@UseGuards(RolesGuard)
@Roles('driver')
export class DriverOrdersController {
  constructor(
    private readonly driverOrders: DriverOrdersService,
    private readonly driverIdScan: DriverIdScanService,
  ) {}

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

  /**
   * Pre-custody bail-out: the driver backs out after accepting but
   * before pickup-confirm. Returns the minimal cancel shape (not the
   * detail bundle) because the order no longer belongs to this driver
   * after the transition — the hydrate would 404 by construction.
   */
  @Post(':id/cancel')
  @RateLimit({ name: 'driver-cancel-delivery', tracker: 'user', limit: 60, windowMs: 60_000 })
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: DriverCancelDeliveryRequestDto,
  ): Promise<DriverCancelDeliveryResponse> {
    return this.driverOrders.cancelDelivery(user.userId, id, body);
  }

  @Post(':id/depart')
  @RateLimit({ name: 'driver-depart', tracker: 'user', limit: 60, windowMs: 60_000 })
  depart(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: DriverDepartRequestDto,
  ): Promise<DriverOrderDetailResponse> {
    return this.driverOrders.confirmDeparture(user.userId, id, body);
  }

  @Post(':id/arrive')
  @RateLimit({ name: 'driver-arrive', tracker: 'user', limit: 60, windowMs: 60_000 })
  arrive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: DriverArriveRequestDto,
  ): Promise<DriverOrderDetailResponse> {
    return this.driverOrders.confirmArrival(user.userId, id, body);
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

  /**
   * Creates a Veriff session and stashes the verification id on the
   * order row. Rate-limited tighter than the polling GET because a
   * driver only legitimately starts a scan once per order — bursty
   * retries (5xx → re-tap) are still in budget, but a stuck client
   * cannot DoS Veriff at our expense.
   */
  @Post(':id/id-scan-session')
  @RateLimit({ name: 'driver-id-scan-session', tracker: 'user', limit: 30, windowMs: 60_000 })
  startIdScanSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<DriverIdScanSessionResponse> {
    return this.driverIdScan.startSession(user.userId, id);
  }

  /**
   * Driver's SDK reported a terminal callback. Backend always queries
   * Veriff for the authoritative decision (the SDK alone is not
   * trustworthy) and writes the outcome idempotently. The fresh
   * hydrate is chained through DriverOrdersService.getForDriver so
   * iOS renders without a follow-up GET.
   */
  @Post(':id/id-scan-result')
  @RateLimit({ name: 'driver-id-scan-result', tracker: 'user', limit: 60, windowMs: 60_000 })
  async submitIdScanResult(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: DriverIdScanResultRequestDto,
  ): Promise<DriverOrderDetailResponse> {
    await this.driverIdScan.submitResult(user.userId, id, body);
    return this.driverOrders.getForDriver(user.userId, id);
  }
}
