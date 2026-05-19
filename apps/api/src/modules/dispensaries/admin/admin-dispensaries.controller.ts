/**
 * /v1/admin/dispensaries HTTP surface.
 *
 *   POST   /v1/admin/dispensaries              — create. Body validated by
 *                                                CreateDispensaryRequestDto.
 *   PATCH  /v1/admin/dispensaries/:id          — partial update. Empty body
 *                                                rejected at the service.
 *   POST   /v1/admin/dispensaries/:id/activate — onboarding/paused → active,
 *                                                with the licence + owner
 *                                                gate. Idempotent on active.
 *   POST   /v1/admin/dispensaries/:id/suspend  — active/onboarding → paused.
 *                                                Idempotent on paused.
 *
 * Auth is admin / superadmin only. The global JwtAuthGuard enforces the
 * "must be authenticated" half; @Roles + @UseGuards(RolesGuard) enforces
 * the "must hold an admin role" half. RolesGuard is opt-in per route by
 * design — the read controller deliberately does not carry it.
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
import { AdminDispensariesService } from './admin-dispensaries.service.js';
import { CreateDispensaryRequestDto, PatchDispensaryRequestDto } from './dto/index.js';
import type { DispensaryResponse } from '../dto/index.js';

@Controller('admin/dispensaries')
@UseGuards(RolesGuard)
@Roles('admin', 'superadmin')
export class AdminDispensariesController {
  constructor(private readonly admin: AdminDispensariesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'admin-dispensary-create', tracker: 'user', limit: 20, windowMs: 60_000 })
  create(@Body() body: CreateDispensaryRequestDto): Promise<DispensaryResponse> {
    return this.admin.create(body);
  }

  @Patch(':id')
  @RateLimit({ name: 'admin-dispensary-patch', tracker: 'user', limit: 60, windowMs: 60_000 })
  patch(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: PatchDispensaryRequestDto,
  ): Promise<DispensaryResponse> {
    return this.admin.patch(id, body);
  }

  @Post(':id/activate')
  @RateLimit({ name: 'admin-dispensary-activate', tracker: 'user', limit: 30, windowMs: 60_000 })
  activate(@Param('id', new ParseUUIDPipe()) id: string): Promise<DispensaryResponse> {
    return this.admin.activate(id);
  }

  @Post(':id/suspend')
  @RateLimit({ name: 'admin-dispensary-suspend', tracker: 'user', limit: 30, windowMs: 60_000 })
  suspend(@Param('id', new ParseUUIDPipe()) id: string): Promise<DispensaryResponse> {
    return this.admin.suspend(id);
  }
}
