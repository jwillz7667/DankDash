/**
 * GET /v1/driver/earnings — bucketed earnings projection for the
 * driver-self wallet.
 *
 * Query: `?period=today|week|month`. The server resolves the bucket
 * to a half-open [since, until) window in America/Chicago and sums
 * delivered-order `delivery_fee_cents + driver_tip_cents` inside it.
 * See `DriverEarningsService` for the policy.
 *
 * Auth: same `Roles('driver')` gate as the rest of this module — JWT
 * resolves the user, RolesGuard narrows to drivers. Consumer / vendor
 * roles never reach here.
 *
 * Rate-limit: 60/min/user. The iOS wallet refresh is a single GET on
 * pull-to-refresh; 60 leaves headroom for a flaky-cell retry pattern
 * without inviting abuse.
 */
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { RateLimit } from '../../../common/decorators/rate-limit.decorator.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { DriverEarningsQueryDto, type DriverEarningsResponse } from '../dto/index.js';
import { DriverEarningsService } from '../services/driver-earnings.service.js';
import type { AuthenticatedUser } from '../../auth/guards/auth-types.js';

@Controller('driver')
@UseGuards(RolesGuard)
@Roles('driver')
export class DriverEarningsController {
  constructor(private readonly earnings: DriverEarningsService) {}

  @Get('earnings')
  @RateLimit({ name: 'driver-earnings', tracker: 'user', limit: 60, windowMs: 60_000 })
  getEarnings(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DriverEarningsQueryDto,
  ): Promise<DriverEarningsResponse> {
    return this.earnings.getEarnings(user.userId, query.period);
  }
}
