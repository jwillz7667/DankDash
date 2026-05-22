/**
 * /v1/me/push-tokens HTTP surface — register and deactivate APNs tokens
 * for the calling user's iOS device.
 *
 *   POST   /v1/me/push-tokens        — register (or refresh) a token
 *   DELETE /v1/me/push-tokens/:id    — deactivate a previously registered token
 *
 * Mounted under `/me` (the same URL hierarchy as identity's /me + Persona
 * webhook controllers) so the iOS clients can group all "things about the
 * calling user" under one path prefix. Both surfaces are JWT-guarded by
 * the global `JwtAuthGuard` plus `RolesGuard` here.
 *
 * Roles allowed: customer (consumer app), driver (driver app). Vendor
 * staff (budtender/manager/owner) use the web portal and don't carry
 * APNs tokens. Admin/superadmin are excluded — operator tooling does
 * not register device tokens.
 *
 * Rate limits are per-user since a single account hammering the register
 * endpoint (e.g. broken iOS retry loop) is the threat shape, not a single
 * IP across accounts.
 */
import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { RegisterPushTokenRequestDto } from './dto/index.js';
import { PushTokensService } from './push-tokens.service.js';
import type { RegisterPushTokenResponse } from './dto/index.js';
import type { AuthenticatedUser } from '../auth/guards/auth-types.js';

@Controller('me/push-tokens')
@UseGuards(RolesGuard)
@Roles('customer', 'driver')
export class PushTokensController {
  constructor(private readonly service: PushTokensService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'push-tokens-register', tracker: 'user', limit: 30, windowMs: 60_000 })
  register(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: RegisterPushTokenRequestDto,
  ): Promise<RegisterPushTokenResponse> {
    return this.service.register(user.userId, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit({ name: 'push-tokens-delete', tracker: 'user', limit: 30, windowMs: 60_000 })
  delete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    return this.service.deactivate(user.userId, id);
  }
}
