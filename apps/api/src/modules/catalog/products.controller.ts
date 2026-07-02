/**
 * /v1/products HTTP surface (read-side).
 *
 *   GET /v1/products/:id          — Public. Returns the product detail + lab
 *                                   results. 404 when the product is missing,
 *                                   soft-deleted, or inactive (the projection
 *                                   inside the service handles all three).
 *   GET /v1/products/:id/listings — Public. The stores actively carrying this
 *                                   product (in-stock), paginated. The consumer
 *                                   app calls this to resolve a concrete listing
 *                                   when a product is opened from search, which
 *                                   is dispensary-agnostic.
 *
 * Product search lives in the SearchController under the same path
 * prefix; Nest's literal-segment precedence (`search` literal beats
 * `:id` param) keeps both routes addressable without an explicit
 * priority annotation. `:id/listings` is a deeper path than `:id`, so it
 * never collides with the detail or search routes.
 */
import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { ProductListingsQueryDto } from './dto/index.js';
import { ProductsService } from './products.service.js';
import type { ProductListingsResponse, ProductResponse } from './dto/index.js';

@Controller()
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Public()
  @RateLimit({ name: 'product-detail-per-ip', tracker: 'ip', limit: 120, windowMs: 60_000 })
  @Get('products/:id')
  getById(@Param('id', new ParseUUIDPipe()) id: string): Promise<ProductResponse> {
    return this.products.getById(id);
  }

  @Public()
  @RateLimit({ name: 'product-listings-per-ip', tracker: 'ip', limit: 120, windowMs: 60_000 })
  @Get('products/:id/listings')
  getListings(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: ProductListingsQueryDto,
  ): Promise<ProductListingsResponse> {
    return this.products.getListings(id, query);
  }
}
