/**
 * /v1/vendor/products — a dispensary authors and manages its OWN catalog
 * products (distinct from the admin-owned global catalog at /v1/admin/products).
 *
 *   GET    /v1/vendor/products      — list this dispensary's authored products
 *   POST   /v1/vendor/products      — create one (201)
 *   PATCH  /v1/vendor/products/:id  — edit one of its own (404 if not owned)
 *   DELETE /v1/vendor/products/:id  — soft-delete one of its own (204)
 *
 * Guard stack matches the other /v1/vendor surfaces: global JwtAuthGuard
 * authenticates, VendorContextGuard binds the dispensary from the
 * X-Dispensary-Id header against `dispensary_staff`, and RolesGuard admits
 * every vendor role (budtender+). Authoring is store-scoped work; the
 * statutory compliance limits (potency caps, beverage rules) are enforced in
 * the service regardless of role, and ownership is enforced per-row via
 * `created_by_dispensary_id`.
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
import { CreateVendorProductDto, PatchVendorProductDto } from './dto/vendor-product.dto.js';
import { VendorProductsService } from './vendor-products.service.js';
import type { VendorContext } from '../../listings/vendor/vendor-context.types.js';
import type { ProductResponse } from '../dto/index.js';

@Controller('vendor/products')
@UseGuards(VendorContextGuard, RolesGuard)
@Roles('budtender', 'manager', 'owner', 'admin', 'superadmin')
export class VendorProductsController {
  constructor(private readonly products: VendorProductsService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'vendor-products-list', tracker: 'user', limit: 120, windowMs: 60_000 })
  async list(
    @CurrentDispensary() ctx: VendorContext,
  ): Promise<{ products: readonly ProductResponse[] }> {
    return { products: await this.products.list(ctx) };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'vendor-products-create', tracker: 'user', limit: 60, windowMs: 60_000 })
  create(
    @CurrentDispensary() ctx: VendorContext,
    @Body() body: CreateVendorProductDto,
  ): Promise<ProductResponse> {
    return this.products.create(ctx, body);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'vendor-products-patch', tracker: 'user', limit: 120, windowMs: 60_000 })
  patch(
    @CurrentDispensary() ctx: VendorContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PatchVendorProductDto,
  ): Promise<ProductResponse> {
    return this.products.patch(ctx, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit({ name: 'vendor-products-delete', tracker: 'user', limit: 60, windowMs: 60_000 })
  remove(
    @CurrentDispensary() ctx: VendorContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.products.remove(ctx, id);
  }
}
