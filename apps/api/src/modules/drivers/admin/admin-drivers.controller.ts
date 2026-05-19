/**
 * /v1/admin/drivers HTTP surface.
 *
 *   POST  /v1/admin/drivers       — onboard a driver. Promotes the
 *                                   linked user to role=driver in the
 *                                   same tx that inserts the drivers
 *                                   row. License number is hashed
 *                                   server-side; plaintext is never
 *                                   logged or persisted.
 *   PATCH /v1/admin/drivers/:id   — update vehicle / insurance /
 *                                   background-check fields. License
 *                                   number is not patchable here.
 *
 * Auth: admin / superadmin only. The global JwtAuthGuard enforces
 * authentication; @Roles + @UseGuards(RolesGuard) enforces the role
 * gate at the class level so every method inherits it without
 * per-method decoration.
 *
 * Rate limits are deliberately tight — admin onboarding is a manual
 * operator workflow, not a bulk loader, so a leaked admin token still
 * cannot churn through the driver catalogue.
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
import { AdminDriversService } from './admin-drivers.service.js';
import { CreateDriverRequestDto, PatchDriverRequestDto } from './dto/index.js';
import type { DriverResponse } from '../dto/index.js';

@Controller('admin/drivers')
@UseGuards(RolesGuard)
@Roles('admin', 'superadmin')
export class AdminDriversController {
  constructor(private readonly admin: AdminDriversService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'admin-driver-create', tracker: 'user', limit: 20, windowMs: 60_000 })
  create(@Body() body: CreateDriverRequestDto): Promise<DriverResponse> {
    return this.admin.create(body);
  }

  @Patch(':id')
  @RateLimit({ name: 'admin-driver-patch', tracker: 'user', limit: 60, windowMs: 60_000 })
  patch(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: PatchDriverRequestDto,
  ): Promise<DriverResponse> {
    return this.admin.patch(id, body);
  }
}
