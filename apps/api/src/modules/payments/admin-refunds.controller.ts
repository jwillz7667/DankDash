/**
 * /v1/admin/refunds/:id/approve HTTP surface — admin-side refund approval.
 *
 * Guards: JwtAuthGuard (global) + RolesGuard restricted to admin /
 * superadmin. Approval is the second half of the separation-of-duties
 * pattern; the vendor controller owns initiation, this controller owns
 * the override gate. The service enforces that the approver cannot be
 * the same user that initiated the refund (matching the DB-level
 * `refunds_separation_of_duties` CHECK).
 *
 * Rate limit is intentionally low — refund approvals are infrequent
 * human decisions; a token issuing dozens per minute is almost
 * certainly an attack or a stuck queue worker pointed at this
 * endpoint by mistake.
 */
import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { RefundsService } from './refunds.service.js';
import type { RefundEnvelopeResponse } from './dto/index.js';
import type { AuthenticatedUser } from '../auth/guards/auth-types.js';

@Controller('admin/refunds')
@UseGuards(RolesGuard)
@Roles('admin', 'superadmin')
export class AdminRefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Post(':id/approve')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'admin-refund-approve', tracker: 'user', limit: 30, windowMs: 60_000 })
  async approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) refundId: string,
  ): Promise<RefundEnvelopeResponse> {
    const refund = await this.refunds.approve(user.userId, refundId);
    return { refund };
  }
}
