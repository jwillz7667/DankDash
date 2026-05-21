/**
 * /v1/addresses HTTP surface — consumer address book.
 *
 *   GET   /v1/addresses        — list the caller's non-deleted addresses,
 *                                 default first.
 *   POST  /v1/addresses        — create a new address. `setAsDefault: true`
 *                                 promotes it in the same call.
 *   PATCH /v1/addresses/:id    — partial update; mutable surface excludes
 *                                 system fields. `isDefault: true` routes
 *                                 through the atomic singleton flip.
 *
 * Guards: JwtAuthGuard binds globally so `req.user` is populated before this
 * controller. RolesGuard narrows to roles that can plausibly own a delivery
 * address — `customer` is primary; `admin`/`superadmin` retain access for
 * support tooling. Vendor + driver roles are excluded; they have their own
 * address surfaces (storefronts via `dispensaries.location`, drivers via
 * `drivers.address` on the driver app).
 *
 * Cross-user PATCH returns 404 (not 403) — same response shape as a missing
 * row so a probe cannot distinguish ownership-fail from existence-fail. The
 * service layer enforces ownership via an explicit findById guard, with RLS
 * as defense in depth.
 *
 * Rate limits are per-user. POST is tighter (5/min) because an address
 * usually persists for the user's lifetime; nobody legitimately creates
 * 20 in a minute. The list endpoint is generous because pull-to-refresh
 * is cheap and routine.
 */
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { AddressesService } from './addresses.service.js';
import {
  CreateAddressRequestDto,
  PatchAddressRequestDto,
  type ListAddressesResponse,
  type UserAddressResponse,
} from './dto/index.js';
import type { AuthenticatedUser } from '../auth/guards/auth-types.js';

@Controller('addresses')
@UseGuards(RolesGuard)
@Roles('customer', 'admin', 'superadmin')
export class AddressesController {
  constructor(private readonly addresses: AddressesService) {}

  @Get()
  @RateLimit({ name: 'addresses-list', tracker: 'user', limit: 120, windowMs: 60_000 })
  list(@CurrentUser() user: AuthenticatedUser): Promise<ListAddressesResponse> {
    return this.addresses.listForUser(user.userId);
  }

  @Post()
  @RateLimit({ name: 'addresses-create', tracker: 'user', limit: 5, windowMs: 60_000 })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateAddressRequestDto,
  ): Promise<UserAddressResponse> {
    return this.addresses.create(user.userId, body);
  }

  @Patch(':id')
  @RateLimit({ name: 'addresses-update', tracker: 'user', limit: 30, windowMs: 60_000 })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: PatchAddressRequestDto,
  ): Promise<UserAddressResponse> {
    return this.addresses.update(user.userId, id, body);
  }
}
