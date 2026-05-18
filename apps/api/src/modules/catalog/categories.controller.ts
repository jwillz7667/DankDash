/**
 * /v1/categories HTTP surface.
 *
 *   GET /v1/categories — Public. Returns the flat list of product
 *                        categories ordered by `display_order`. The iOS
 *                        client renders these on the browse tab before the
 *                        user has signed in, so the route is @Public and
 *                        rate-limited per IP.
 *
 * The handler is a one-line delegation to CategoriesService — projection
 * and ordering live there so the controller stays trivially testable as a
 * pass-through.
 */
import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { CategoriesService } from './categories.service.js';
import type { CategoryListResponse } from './dto/index.js';

@Controller()
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Public()
  @RateLimit({ name: 'categories-list-per-ip', tracker: 'ip', limit: 60, windowMs: 60_000 })
  @Get('categories')
  async list(): Promise<CategoryListResponse> {
    const rows = await this.categories.list();
    return { categories: rows };
  }
}
