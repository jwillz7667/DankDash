/**
 * /v1/admin/categories HTTP surface.
 *
 *   POST /v1/admin/categories — create. Body validated by
 *                               CreateCategoryRequestDto.
 *
 * Auth is admin / superadmin only. The global JwtAuthGuard enforces the
 * "must be authenticated" half; @Roles + @UseGuards(RolesGuard) enforces
 * the "must hold an admin role" half. RolesGuard is opt-in per route by
 * design — the public read controller deliberately does not carry it.
 *
 * Phase 4.3 scopes this surface to create-only; renames and re-slugs go
 * through a future admin tool that emits a migration job rather than a
 * silent UPDATE (would break iOS deep links).
 */
import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { RateLimit } from '../../../common/decorators/rate-limit.decorator.js';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { AdminCategoriesService } from './admin-categories.service.js';
import { CreateCategoryRequestDto } from './dto/index.js';
import type { CategoryResponse } from '../dto/index.js';

@Controller('admin/categories')
@UseGuards(RolesGuard)
@Roles('admin', 'superadmin')
export class AdminCategoriesController {
  constructor(private readonly admin: AdminCategoriesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'admin-category-create', tracker: 'user', limit: 20, windowMs: 60_000 })
  create(@Body() body: CreateCategoryRequestDto): Promise<CategoryResponse> {
    return this.admin.create(body);
  }
}
