/**
 * /v1/dispensaries HTTP surface (read-side).
 *
 *   GET /v1/dispensaries[?lat=&lng=]   — Public. Flat list of active
 *                                         dispensaries, optionally filtered
 *                                         to those whose delivery polygon
 *                                         contains the (lat,lng) point.
 *   GET /v1/dispensaries/:id           — Public. Single dispensary detail.
 *                                         404 on missing/soft-deleted/
 *                                         non-active.
 *   GET /v1/dispensaries/:id/menu      — Public. Per-listing menu with
 *                                         denormalized product fields.
 *
 * Admin writes (POST/PATCH, activate/suspend) land in Phase 4.3 under
 * /v1/admin/dispensaries and use a separate controller so the public read
 * surface stays trivially auditable as @Public + rate-limited.
 *
 * Rate limits are tighter on the list (which can return MB of polygon data
 * per request) than on detail/menu (which are bounded by a single store).
 */
import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { DispensariesService } from './dispensaries.service.js';
import {
  ListDispensariesQueryDto,
  type DispensaryListResponse,
  type DispensaryResponse,
  type MenuResponse,
} from './dto/index.js';

@Controller()
export class DispensariesController {
  constructor(private readonly dispensaries: DispensariesService) {}

  @Public()
  @RateLimit({ name: 'dispensaries-list-per-ip', tracker: 'ip', limit: 60, windowMs: 60_000 })
  @Get('dispensaries')
  async list(@Query() query: ListDispensariesQueryDto): Promise<DispensaryListResponse> {
    const rows = await this.dispensaries.list(query);
    return { dispensaries: rows };
  }

  @Public()
  @RateLimit({ name: 'dispensary-detail-per-ip', tracker: 'ip', limit: 120, windowMs: 60_000 })
  @Get('dispensaries/:id')
  getById(@Param('id', new ParseUUIDPipe()) id: string): Promise<DispensaryResponse> {
    return this.dispensaries.getById(id);
  }

  @Public()
  @RateLimit({ name: 'dispensary-menu-per-ip', tracker: 'ip', limit: 120, windowMs: 60_000 })
  @Get('dispensaries/:id/menu')
  getMenu(@Param('id', new ParseUUIDPipe()) id: string): Promise<MenuResponse> {
    return this.dispensaries.getMenu(id);
  }
}
