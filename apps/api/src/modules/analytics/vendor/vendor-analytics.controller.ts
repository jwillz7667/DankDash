/**
 * /v1/vendor/analytics HTTP surface (Phase 15.2).
 *
 *   GET /v1/vendor/analytics/sales?from=ISO&to=ISO
 *   GET /v1/vendor/analytics/products?from=ISO&to=ISO
 *
 * Guards are the same stack the rest of /v1/vendor uses:
 *
 *   1. Global JwtAuthGuard
 *   2. VendorContextGuard (attaches the typed VendorContext)
 *   3. RolesGuard (narrowed to staff + support)
 *
 * Rate limits sized for dashboard polling: each page renders the chart
 * once on mount and refetches when the operator changes the date range,
 * so 60 requests/minute per principal is enough headroom for an
 * occasional accidental double-click without sheltering a runaway
 * client that pulls a year's window every second.
 */
import { Controller, Get, HttpCode, HttpStatus, Query, UseGuards } from '@nestjs/common';
import { RateLimit } from '../../../common/decorators/rate-limit.decorator.js';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { CurrentDispensary } from '../../listings/vendor/current-dispensary.decorator.js';
import { VendorContextGuard } from '../../listings/vendor/vendor-context.guard.js';
import {
  ProductsAnalyticsQueryDto,
  SalesAnalyticsQueryDto,
  type ProductsAnalyticsResponse,
  type SalesAnalyticsResponse,
} from './dto/index.js';
import { VendorAnalyticsService } from './vendor-analytics.service.js';
import type { VendorContext } from '../../listings/vendor/vendor-context.types.js';

@Controller('vendor/analytics')
@UseGuards(VendorContextGuard, RolesGuard)
@Roles('budtender', 'manager', 'owner', 'admin', 'superadmin')
export class VendorAnalyticsController {
  constructor(private readonly analytics: VendorAnalyticsService) {}

  @Get('sales')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'vendor-analytics-sales', tracker: 'user', limit: 60, windowMs: 60_000 })
  sales(
    @CurrentDispensary() ctx: VendorContext,
    @Query() query: SalesAnalyticsQueryDto,
  ): Promise<SalesAnalyticsResponse> {
    return this.analytics.sales(ctx, query);
  }

  @Get('products')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'vendor-analytics-products', tracker: 'user', limit: 60, windowMs: 60_000 })
  products(
    @CurrentDispensary() ctx: VendorContext,
    @Query() query: ProductsAnalyticsQueryDto,
  ): Promise<ProductsAnalyticsResponse> {
    return this.analytics.products(ctx, query);
  }
}
