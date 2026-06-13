/**
 * /v1/driver/deliveries — open-pool delivery HTTP surface.
 *
 *   GET  /v1/driver/deliveries/available       — claimable ready orders
 *   POST /v1/driver/deliveries/:orderId/claim   — first-come claim
 *
 * Auth: global JwtAuthGuard authenticates the principal;
 * DriverContextGuard (class-level) refuses non-driver principals and
 * attaches the `DriverContext` for `@CurrentDriver()`.
 *
 * Rate limits: the dasher map polls `available` on the shift cadence
 * (~10s) — 120/min is double that with headroom for a focus refresh.
 * A claim is a single decisive tap; 30/min absorbs "tapped, blip,
 * retried" while clamping a runaway client.
 */
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { RateLimit } from '../../../common/decorators/rate-limit.decorator.js';
import { CurrentDriver } from '../context/current-driver.decorator.js';
import { DriverContextGuard } from '../context/driver-context.guard.js';
import { DriverDeliveriesService } from './driver-deliveries.service.js';
import type { AvailableDeliveriesResponse, ClaimDeliveryResponse } from './dto/index.js';
import type { DriverContext } from '../context/driver-context.types.js';

@Controller('driver/deliveries')
@UseGuards(DriverContextGuard)
export class DriverDeliveriesController {
  constructor(private readonly deliveries: DriverDeliveriesService) {}

  @Get('available')
  @RateLimit({ name: 'driver-deliveries-available', tracker: 'user', limit: 120, windowMs: 60_000 })
  listAvailable(@CurrentDriver() ctx: DriverContext): Promise<AvailableDeliveriesResponse> {
    return this.deliveries.listAvailable(ctx);
  }

  @Post(':orderId/claim')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'driver-delivery-claim', tracker: 'user', limit: 30, windowMs: 60_000 })
  claim(
    @CurrentDriver() ctx: DriverContext,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
  ): Promise<ClaimDeliveryResponse> {
    return this.deliveries.claim(ctx, orderId);
  }
}
