/**
 * /v1/vendor/staff HTTP surface (Phase 15.4).
 *
 *   GET    /v1/vendor/staff        — list roster (active + removed)
 *   POST   /v1/vendor/staff        — invite an existing user by email
 *   PATCH  /v1/vendor/staff/:id    — change role
 *   DELETE /v1/vendor/staff/:id    — soft-remove (set removed_at)
 *
 * Guards stack identically to the other /v1/vendor controllers:
 *
 *   1. Global JwtAuthGuard
 *   2. VendorContextGuard
 *   3. RolesGuard (narrowed to manager+; budtenders are blocked at the
 *      platform-role gate plus the sidebar role gate in Phase 13)
 *
 * The platform-level `@Roles` allowlist gates *entry* to the controller.
 * The per-dispensary owner-only invariants (assigning `owner`, last-owner
 * protection) live in the service so they can be unit tested against
 * fakes — they are not expressible as a single decorator.
 *
 * Rate limits: list endpoint sized to support polling-style refreshes
 * (120/min); mutate endpoints capped tighter (30/min) because an owner
 * doesn't bulk-invite via UI.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { RateLimit } from '../../../common/decorators/rate-limit.decorator.js';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { CurrentDispensary } from '../../listings/vendor/current-dispensary.decorator.js';
import { VendorContextGuard } from '../../listings/vendor/vendor-context.guard.js';
import {
  InviteStaffRequestDto,
  PatchStaffRequestDto,
  type VendorStaffListResponse,
  type VendorStaffResponse,
} from './dto/index.js';
import { VendorStaffService } from './vendor-staff.service.js';
import type { VendorContext } from '../../listings/vendor/vendor-context.types.js';

@Controller('vendor/staff')
@UseGuards(VendorContextGuard, RolesGuard)
@Roles('manager', 'owner', 'admin', 'superadmin')
export class VendorStaffController {
  constructor(private readonly staff: VendorStaffService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'vendor-staff-list', tracker: 'user', limit: 120, windowMs: 60_000 })
  list(@CurrentDispensary() ctx: VendorContext): Promise<VendorStaffListResponse> {
    return this.staff.list(ctx);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'vendor-staff-invite', tracker: 'user', limit: 30, windowMs: 60_000 })
  invite(
    @CurrentDispensary() ctx: VendorContext,
    @Body() body: InviteStaffRequestDto,
  ): Promise<VendorStaffResponse> {
    return this.staff.invite(ctx, body);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'vendor-staff-patch', tracker: 'user', limit: 30, windowMs: 60_000 })
  patchRole(
    @CurrentDispensary() ctx: VendorContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: PatchStaffRequestDto,
  ): Promise<VendorStaffResponse> {
    return this.staff.patchRole(ctx, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit({ name: 'vendor-staff-delete', tracker: 'user', limit: 30, windowMs: 60_000 })
  remove(
    @CurrentDispensary() ctx: VendorContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    return this.staff.remove(ctx, id);
  }
}
