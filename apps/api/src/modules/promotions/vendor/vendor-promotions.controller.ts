/**
 * /v1/vendor/promotions HTTP surface — dispensary-scoped promo codes.
 *
 *   GET    /v1/vendor/promotions       — list the dispensary's promos
 *   POST   /v1/vendor/promotions       — create (201)
 *   PATCH  /v1/vendor/promotions/:id   — toggle active
 *   DELETE /v1/vendor/promotions/:id   — deactivate (204)
 *
 * Guards: JwtAuthGuard (global) → VendorContextGuard (pins the dispensary via
 * X-Dispensary-Id and verifies staff membership) → RolesGuard. @Roles is the
 * coarse JWT gate (manager/owner staff, plus admin/superadmin for support);
 * the authoritative manager+ per-dispensary check lives in the service, so a
 * budtender who slips past the coarse gate is still rejected.
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
import { CreatePromoRequestDto, PatchPromoRequestDto } from '../dto/index.js';
import { VendorPromotionsService } from './vendor-promotions.service.js';
import type { VendorContext } from '../../listings/vendor/vendor-context.types.js';
import type { PromoListResponse, PromoResponse } from '../dto/index.js';

@Controller('vendor/promotions')
@UseGuards(VendorContextGuard, RolesGuard)
@Roles('manager', 'owner', 'admin', 'superadmin')
export class VendorPromotionsController {
  constructor(private readonly promotions: VendorPromotionsService) {}

  @Get()
  @RateLimit({ name: 'vendor-promo-list', tracker: 'user', limit: 120, windowMs: 60_000 })
  list(@CurrentDispensary() ctx: VendorContext): Promise<PromoListResponse> {
    return this.promotions.list(ctx);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'vendor-promo-create', tracker: 'user', limit: 30, windowMs: 60_000 })
  create(
    @CurrentDispensary() ctx: VendorContext,
    @Body() body: CreatePromoRequestDto,
  ): Promise<PromoResponse> {
    return this.promotions.create(ctx, body);
  }

  @Patch(':id')
  @RateLimit({ name: 'vendor-promo-patch', tracker: 'user', limit: 60, windowMs: 60_000 })
  patch(
    @CurrentDispensary() ctx: VendorContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: PatchPromoRequestDto,
  ): Promise<PromoResponse> {
    return this.promotions.patch(ctx, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit({ name: 'vendor-promo-delete', tracker: 'user', limit: 60, windowMs: 60_000 })
  delete(
    @CurrentDispensary() ctx: VendorContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    return this.promotions.deactivate(ctx, id);
  }
}
