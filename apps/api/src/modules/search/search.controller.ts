/**
 * /v1/products/search HTTP surface (read-side).
 *
 *   GET /v1/products/search — Public. Faceted product search. Accepts
 *                             `q`, `category`, `strain_type`, `dispensary_id`,
 *                             `limit`, `offset` (see SearchProductsQueryDto
 *                             for exact shapes). Returns ranked results plus
 *                             facet counts the iOS browse UI renders inline.
 *
 * Co-existence with `GET /v1/products/:id` (in CatalogModule's
 * ProductsController) works because Nest's Fastify adapter resolves literal
 * path segments before parameterised ones. `search` is a literal segment, so
 * a request for `/v1/products/search?q=...` is routed here rather than to
 * `getById(':id')` with id="search".
 *
 * Search is the most aggressively bot-targeted public endpoint (scraping
 * runs hit it the moment a category goes live). The IP rate limit is
 * deliberately tighter than the menu/category surfaces — 30/min vs. 60/120.
 */
import { Controller, Get, Query } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { SearchProductsQueryDto } from './dto/index.js';
import { SearchService } from './search.service.js';
import type { SearchProductsResponse } from './dto/index.js';

@Controller()
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Public()
  @RateLimit({ name: 'product-search-per-ip', tracker: 'ip', limit: 30, windowMs: 60_000 })
  @Get('products/search')
  searchProducts(@Query() query: SearchProductsQueryDto): Promise<SearchProductsResponse> {
    return this.search.search(query);
  }
}
