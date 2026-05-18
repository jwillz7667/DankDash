/**
 * /v1/admin/products HTTP surface.
 *
 *   POST  /v1/admin/products              — create. Body validated by
 *                                           CreateProductRequestDto.
 *   PATCH /v1/admin/products/:id          — partial update. Empty body
 *                                           rejected at the service.
 *   POST  /v1/admin/products/:id/lab-results
 *                                         — append a COA for a batch.
 *                                           Duplicate (productId, batchId)
 *                                           rejected as 409.
 *
 * Auth is admin / superadmin only. The global JwtAuthGuard enforces the
 * "must be authenticated" half; @Roles + @UseGuards(RolesGuard) enforces
 * the "must hold an admin role" half. RolesGuard is opt-in per route by
 * design — the public read controller deliberately does not carry it.
 *
 * No @Public is set on any handler — that's the deny-by-default posture.
 * Rate limits are looser than the public surface (admins make small
 * numbers of large mutations, not large numbers of small reads), but
 * present so a leaked admin token still cannot wreck the catalogue.
 */
import {
  Body,
  Controller,
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
import { AdminProductsService } from './admin-products.service.js';
import {
  CreateLabResultRequestDto,
  CreateProductRequestDto,
  PatchProductRequestDto,
} from './dto/index.js';
import type { ProductResponse } from '../dto/index.js';

@Controller('admin/products')
@UseGuards(RolesGuard)
@Roles('admin', 'superadmin')
export class AdminProductsController {
  constructor(private readonly admin: AdminProductsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'admin-product-create', tracker: 'user', limit: 30, windowMs: 60_000 })
  create(@Body() body: CreateProductRequestDto): Promise<ProductResponse> {
    return this.admin.create(body);
  }

  @Patch(':id')
  @RateLimit({ name: 'admin-product-patch', tracker: 'user', limit: 60, windowMs: 60_000 })
  patch(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: PatchProductRequestDto,
  ): Promise<ProductResponse> {
    return this.admin.patch(id, body);
  }

  @Post(':id/lab-results')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'admin-product-lab-result', tracker: 'user', limit: 30, windowMs: 60_000 })
  createLabResult(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CreateLabResultRequestDto,
  ): Promise<ProductResponse> {
    return this.admin.createLabResult(id, body);
  }
}
