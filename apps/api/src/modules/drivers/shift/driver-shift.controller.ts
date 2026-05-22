/**
 * /v1/driver — driver-self shift + status HTTP surface.
 *
 *   POST /v1/driver/shift/start  — open a shift with a starting ping
 *   POST /v1/driver/shift/end    — close the active shift
 *   POST /v1/driver/status       — change online/break/unavailable
 *
 * Auth: global JwtAuthGuard authenticates the caller; DriverContextGuard
 * (applied at the class level) refuses non-driver principals and
 * attaches a `DriverContext` for `@CurrentDriver()` to read.
 *
 * Rate limits are sized for human + retry behaviour: shift open/close
 * is a per-shift event (low limit, per-user), status flips are more
 * frequent (driver on break → back → break again) so they sit higher.
 */
import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { RateLimit } from '../../../common/decorators/rate-limit.decorator.js';
import { CurrentDriver } from '../context/current-driver.decorator.js';
import { DriverContextGuard } from '../context/driver-context.guard.js';
import { DriverShiftService } from './driver-shift.service.js';
import {
  EndShiftRequestDto,
  StartShiftRequestDto,
  UpdateDriverStatusRequestDto,
  type DriverShiftResponse,
} from './dto/index.js';
import type { DriverContext } from '../context/driver-context.types.js';
import type { DriverResponse } from '../dto/index.js';

@Controller('driver')
@UseGuards(DriverContextGuard)
export class DriverShiftController {
  constructor(private readonly shifts: DriverShiftService) {}

  @Post('shift/start')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'driver-shift-start', tracker: 'user', limit: 10, windowMs: 60_000 })
  start(
    @CurrentDriver() ctx: DriverContext,
    @Body() body: StartShiftRequestDto,
  ): Promise<DriverShiftResponse> {
    return this.shifts.start(ctx, body);
  }

  @Post('shift/end')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'driver-shift-end', tracker: 'user', limit: 10, windowMs: 60_000 })
  end(
    @CurrentDriver() ctx: DriverContext,
    @Body() body: EndShiftRequestDto,
  ): Promise<DriverShiftResponse> {
    return this.shifts.end(ctx, body);
  }

  @Post('status')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'driver-status-update', tracker: 'user', limit: 60, windowMs: 60_000 })
  updateStatus(
    @CurrentDriver() ctx: DriverContext,
    @Body() body: UpdateDriverStatusRequestDto,
  ): Promise<DriverResponse> {
    return this.shifts.updateStatus(ctx, body.status);
  }
}
