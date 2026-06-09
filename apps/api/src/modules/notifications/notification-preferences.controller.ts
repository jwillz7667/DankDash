/**
 * /v1/me/notification-preferences HTTP surface — the caller's notification
 * delivery toggles.
 *
 *   GET   /v1/me/notification-preferences  — effective preferences (defaults
 *                                            when none saved yet).
 *   PATCH /v1/me/notification-preferences  — partial update of any subset of
 *                                            the five toggles.
 *
 * Mounted under `/me` alongside push-tokens + identity so everything about the
 * calling user shares one path prefix. Self-scoped: no `:id` param, so there
 * is no cross-user surface to guard — a caller only ever touches their own row.
 *
 * Roles: customer (consumer app) and driver (DankDasher) — both have an iOS
 * settings screen. Vendor staff use the portal (no per-channel device prefs)
 * and admin/superadmin don't carry consumer preferences. Mirrors the
 * push-tokens controller's role set.
 *
 * Rate limits are per-user. The list/read path is generous (settings screen
 * loads on open + pull-to-refresh); PATCH is tighter since a human flips a
 * switch a handful of times, not dozens per minute.
 */
import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { UpdateNotificationPreferencesRequestDto } from './dto/index.js';
import { NotificationPreferencesService } from './notification-preferences.service.js';
import type { NotificationPreferencesResponse } from './dto/index.js';
import type { AuthenticatedUser } from '../auth/guards/auth-types.js';

@Controller('me/notification-preferences')
@UseGuards(RolesGuard)
@Roles('customer', 'driver')
export class NotificationPreferencesController {
  constructor(private readonly service: NotificationPreferencesService) {}

  @Get()
  @RateLimit({ name: 'notification-prefs-get', tracker: 'user', limit: 120, windowMs: 60_000 })
  get(@CurrentUser() user: AuthenticatedUser): Promise<NotificationPreferencesResponse> {
    return this.service.getForUser(user.userId);
  }

  @Patch()
  @RateLimit({ name: 'notification-prefs-update', tracker: 'user', limit: 30, windowMs: 60_000 })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateNotificationPreferencesRequestDto,
  ): Promise<NotificationPreferencesResponse> {
    return this.service.update(user.userId, body);
  }
}
