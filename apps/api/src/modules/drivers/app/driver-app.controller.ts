/**
 * /v1/driver — read-only driver-app surface (Phase 8.5).
 *
 *   GET /v1/driver/current-route   — order in flight + pickup + dropoff
 *   GET /v1/driver/earnings        — bucketed tips + fees + deliveries
 *   GET /v1/driver/shifts          — recent shift history
 *
 * Auth: global JwtAuthGuard authenticates the principal;
 * DriverContextGuard (class-level) refuses non-driver principals and
 * attaches the `DriverContext` for `@CurrentDriver()`.
 *
 * These endpoints are mounted on the same `/v1/driver` base as the
 * shift controller (NestJS allows the same base path across multiple
 * controllers; routes are merged at the router layer). Splitting the
 * read surface into its own controller keeps the service composition
 * narrow — the shift controller doesn't need OrdersRepository /
 * DispensariesRepository injected.
 *
 * Rate limits sized for the driver app's polling cadence: current-route
 * is polled every few seconds while a delivery is in flight, so it sits
 * high (120/min). Earnings + shifts are dashboard cards, polled on
 * navigation only, so they sit lower (30/min).
 */
import { Controller, Get, HttpCode, HttpStatus, Query, UseGuards } from '@nestjs/common';
import { RateLimit } from '../../../common/decorators/rate-limit.decorator.js';
import { CurrentDriver } from '../context/current-driver.decorator.js';
import { DriverContextGuard } from '../context/driver-context.guard.js';
import { DriverAppService } from './driver-app.service.js';
import {
  EarningsQueryDto,
  type CurrentRouteResponse,
  type EarningsResponse,
  type ShiftsListResponse,
} from './dto/index.js';
import type { DriverContext } from '../context/driver-context.types.js';

@Controller('driver')
@UseGuards(DriverContextGuard)
export class DriverAppController {
  constructor(private readonly app: DriverAppService) {}

  @Get('current-route')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'driver-current-route', tracker: 'user', limit: 120, windowMs: 60_000 })
  currentRoute(@CurrentDriver() ctx: DriverContext): Promise<CurrentRouteResponse> {
    return this.app.currentRoute(ctx);
  }

  @Get('earnings')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'driver-earnings', tracker: 'user', limit: 30, windowMs: 60_000 })
  earnings(
    @CurrentDriver() ctx: DriverContext,
    @Query() query: EarningsQueryDto,
  ): Promise<EarningsResponse> {
    return this.app.earnings(ctx, query);
  }

  @Get('shifts')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'driver-shifts-list', tracker: 'user', limit: 30, windowMs: 60_000 })
  shifts(@CurrentDriver() ctx: DriverContext): Promise<ShiftsListResponse> {
    return this.app.shifts(ctx);
  }
}
