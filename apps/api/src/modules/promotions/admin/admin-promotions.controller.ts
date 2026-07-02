/**
 * /v1/admin/promotions HTTP surface — platform-scoped promo codes.
 *
 *   GET    /v1/admin/promotions       — list platform promos
 *   POST   /v1/admin/promotions       — create (201)
 *   PATCH  /v1/admin/promotions/:id   — toggle active
 *   DELETE /v1/admin/promotions/:id   — deactivate (204)
 *
 * JwtAuthGuard (global) authenticates; @Roles + RolesGuard require an admin
 * role. Platform promos are funded by the platform, so only platform staff
 * may mint them.
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
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { CreatePromoRequestDto, PatchPromoRequestDto } from '../dto/index.js';
import { AdminPromotionsService } from './admin-promotions.service.js';
import type { AuthenticatedUser } from '../../auth/guards/auth-types.js';
import type { PromoListResponse, PromoResponse } from '../dto/index.js';

@Controller('admin/promotions')
@UseGuards(RolesGuard)
@Roles('admin', 'superadmin')
export class AdminPromotionsController {
  constructor(private readonly promotions: AdminPromotionsService) {}

  @Get()
  @RateLimit({ name: 'admin-promo-list', tracker: 'user', limit: 120, windowMs: 60_000 })
  list(): Promise<PromoListResponse> {
    return this.promotions.list();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'admin-promo-create', tracker: 'user', limit: 30, windowMs: 60_000 })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreatePromoRequestDto,
  ): Promise<PromoResponse> {
    return this.promotions.create(user.userId, body);
  }

  @Patch(':id')
  @RateLimit({ name: 'admin-promo-patch', tracker: 'user', limit: 60, windowMs: 60_000 })
  patch(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: PatchPromoRequestDto,
  ): Promise<PromoResponse> {
    return this.promotions.patch(id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit({ name: 'admin-promo-delete', tracker: 'user', limit: 60, windowMs: 60_000 })
  delete(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    return this.promotions.deactivate(id);
  }
}
