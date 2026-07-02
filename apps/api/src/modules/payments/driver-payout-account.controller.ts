/**
 * /v1/driver/payouts/bank-account HTTP surface — driver payout bank linking.
 * The driver-side analogue of VendorPayoutAccountController.
 *
 *   POST /v1/driver/payouts/bank-account/link  — start an Aeropay hosted
 *                                                 bank-link session; returns
 *                                                 the URL the app opens
 *   GET  /v1/driver/payouts/bank-account       — read link status (boolean)
 *
 * Guard stack mirrors the rest of /v1/driver (and DriverCashoutController
 * this sits alongside):
 *
 *   1. Global JwtAuthGuard — authenticates the principal, attaches the user.
 *   2. RolesGuard @Roles('driver') — only drivers manage driver payout
 *      banking; consumer / vendor roles never reach here.
 *
 * Unlike the vendor surface there is no dispensary context to resolve — the
 * bank ref is keyed on the driver's own `users.id` (from the JWT), so
 * `@CurrentUser()` is the only scope needed, identical to the cashout
 * controller.
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { DriverBankLinkService } from './driver-bank-link.service.js';
import { StartDriverBankLinkRequestDto } from './dto/index.js';
import type { DriverBankAccountStatusResponse, StartDriverBankLinkResponse } from './dto/index.js';
import type { AuthenticatedUser } from '../auth/guards/auth-types.js';

@Controller('driver/payouts/bank-account')
@UseGuards(RolesGuard)
@Roles('driver')
export class DriverPayoutAccountController {
  constructor(private readonly service: DriverBankLinkService) {}

  @Post('link')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'driver-payout-bank-link', tracker: 'user', limit: 10, windowMs: 60_000 })
  startLink(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: StartDriverBankLinkRequestDto,
  ): Promise<StartDriverBankLinkResponse> {
    return this.service.startLink(user.userId, body.returnUrl);
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'driver-payout-bank-status', tracker: 'user', limit: 60, windowMs: 60_000 })
  getStatus(@CurrentUser() user: AuthenticatedUser): Promise<DriverBankAccountStatusResponse> {
    return this.service.getStatus(user.userId);
  }
}
