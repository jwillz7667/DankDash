/**
 * POST /v1/driver/cashout — driver-initiated cashout request.
 *
 * Phase 20 ships the persistence layer + balance gate. The upstream
 * Aeropay payout call is stubbed behind `AEROPAY_LIVE=false` (default);
 * see `DriverCashoutService` and `aeropay-driver-payout.gateway.ts`
 * for the orchestration and stub.
 *
 * Auth: `Roles('driver')` — same gate as the rest of the driver
 * module. Consumer / vendor roles never reach here.
 *
 * Rate-limit: 10/min/user. Cashout is a low-frequency, high-value
 * action — a user legitimately taps it once and the iOS layer should
 * disable the CTA on success. 10/min absorbs accidental double-taps
 * and flaky-cell retries without inviting brute-force or balance
 * probing.
 */
import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { RateLimit } from '../../../common/decorators/rate-limit.decorator.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { DriverCashoutRequestDto, type DriverCashoutResponse } from '../dto/index.js';
import { DriverCashoutService } from '../services/driver-cashout.service.js';
import type { AuthenticatedUser } from '../../auth/guards/auth-types.js';

@Controller('driver')
@UseGuards(RolesGuard)
@Roles('driver')
export class DriverCashoutController {
  constructor(private readonly cashout: DriverCashoutService) {}

  @Post('cashout')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'driver-cashout', tracker: 'user', limit: 10, windowMs: 60_000 })
  request(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: DriverCashoutRequestDto,
  ): Promise<DriverCashoutResponse> {
    return this.cashout.requestCashout(user.userId, body.amountCents);
  }
}
