/**
 * /v1/vendor/settings HTTP surface (Phase 15.5).
 *
 *   GET   /v1/vendor/settings  — full settings response
 *   PATCH /v1/vendor/settings  — update editable fields
 *
 * Guards stack identically to the other /v1/vendor controllers:
 *   1. Global JwtAuthGuard
 *   2. VendorContextGuard
 *   3. RolesGuard (manager+ at the platform-role gate; budtenders blocked)
 *
 * The dispensary-level permission split (managers can edit hours and
 * branding; owner-only fields like license/address require a platform
 * admin escalation) is enforced inside the service when those fields
 * gain UI flows — for the current set, manager+ is the right bar.
 *
 * Rate limits sized so a settings page that auto-saves on blur doesn't
 * trip the limiter (60/min on PATCH), while still capping a runaway
 * client. GET is lightly capped at 120/min.
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Patch, UseGuards } from '@nestjs/common';
import { RateLimit } from '../../../common/decorators/rate-limit.decorator.js';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { CurrentDispensary } from '../../listings/vendor/current-dispensary.decorator.js';
import { VendorContextGuard } from '../../listings/vendor/vendor-context.guard.js';
import { PatchVendorSettingsDto, type VendorSettingsResponse } from './dto/index.js';
import { VendorSettingsService } from './vendor-settings.service.js';
import type { VendorContext } from '../../listings/vendor/vendor-context.types.js';

@Controller('vendor/settings')
@UseGuards(VendorContextGuard, RolesGuard)
@Roles('manager', 'owner', 'admin', 'superadmin')
export class VendorSettingsController {
  constructor(private readonly settings: VendorSettingsService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'vendor-settings-get', tracker: 'user', limit: 120, windowMs: 60_000 })
  get(@CurrentDispensary() ctx: VendorContext): Promise<VendorSettingsResponse> {
    return this.settings.get(ctx);
  }

  @Patch()
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'vendor-settings-patch', tracker: 'user', limit: 60, windowMs: 60_000 })
  patch(
    @CurrentDispensary() ctx: VendorContext,
    @Body() body: PatchVendorSettingsDto,
  ): Promise<VendorSettingsResponse> {
    return this.settings.patch(ctx, body);
  }
}
