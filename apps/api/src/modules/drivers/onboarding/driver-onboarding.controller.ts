/**
 * /v1/driver — driver-self onboarding surface (Phase 19 completion).
 *
 *   GET  /v1/driver/me             — driver self-projection (404 when
 *                                    the principal has no drivers row)
 *   POST /v1/driver/applications   — submit a driver application: create
 *                                    a pending drivers row + promote the
 *                                    principal to role=driver
 *
 * Auth: the global JwtAuthGuard authenticates the principal and attaches
 * `@CurrentUser()`. These routes deliberately do NOT use
 * DriverContextGuard — that guard 403s any principal without an existing
 * drivers row, which is exactly the population that needs to reach these
 * endpoints (a customer applying to drive, or a pending applicant
 * polling `me`). The "no drivers row" case is expressed as a 404 from
 * `me`, not a 403 from a guard, because the client routes on that 404.
 *
 * Mounted on the same `/v1/driver` base as DriverAppController and
 * DriverShiftController — NestJS merges routes across controllers that
 * share a base path. The route paths here (`me`, `applications`) don't
 * collide with the guarded controllers' paths (`current-route`,
 * `shifts`, `status`, …), so each route keeps its own controller's
 * guard set.
 *
 * Rate limits: `me` is polled on a 30s cadence by the pending screen, so
 * it sits at 60/min (room for the poll plus manual refreshes).
 * `applications` is a one-shot human action — 10/min is generous and
 * still caps a leaked token from churning driver rows.
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { RateLimit } from '../../../common/decorators/rate-limit.decorator.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import { DriverOnboardingService } from './driver-onboarding.service.js';
import { DriverApplicationRequestDto } from './dto/index.js';
import type { DriverApplicationResponse } from './dto/index.js';
import type { AuthenticatedUser } from '../../auth/guards/auth-types.js';
import type { DriverResponse } from '../dto/index.js';

@Controller('driver')
export class DriverOnboardingController {
  constructor(private readonly onboarding: DriverOnboardingService) {}

  @Get('me')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'driver-me', tracker: 'user', limit: 60, windowMs: 60_000 })
  me(@CurrentUser() user: AuthenticatedUser): Promise<DriverResponse> {
    return this.onboarding.me(user.userId);
  }

  @Post('applications')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'driver-application-submit', tracker: 'user', limit: 10, windowMs: 60_000 })
  apply(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: DriverApplicationRequestDto,
  ): Promise<DriverApplicationResponse> {
    return this.onboarding.apply(user.userId, body);
  }
}
