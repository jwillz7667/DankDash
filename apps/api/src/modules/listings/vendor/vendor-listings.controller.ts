/**
 * /v1/vendor/listings HTTP surface.
 *
 *   GET    /v1/vendor/listings           — list every listing the dispensary
 *                                          owns, active or not.
 *   POST   /v1/vendor/listings           — create. Body validated by
 *                                          CreateListingRequestDto.
 *   PATCH  /v1/vendor/listings/:id       — partial update. Empty body
 *                                          rejected at the service.
 *   DELETE /v1/vendor/listings/:id       — soft-delete (flip isActive=false).
 *                                          204 No Content on success; 404 on
 *                                          missing or cross-vendor (same
 *                                          shape so probing cannot
 *                                          distinguish the two).
 *
 * Three guards stack on this controller:
 *
 *   1. Global JwtAuthGuard — authenticates the principal. Already bound
 *      in the root composition, runs first.
 *   2. VendorContextGuard  — reads the X-Dispensary-Id header, verifies
 *      the principal is an active staff member of that dispensary via
 *      `dispensary_staff` (`removedAt IS NULL`), and attaches a typed
 *      VendorContext to the request (`@CurrentDispensary()` reads it).
 *   3. RolesGuard          — narrows the JWT role allow-list to the
 *      shapes that can legitimately hit a vendor endpoint. The role
 *      enum is shared between user records and dispensary_staff, so a
 *      staffed user's JWT role is one of `budtender`/`manager`/`owner`;
 *      `admin`/`superadmin` retain access for support tooling.
 *      `customer`/`driver` are explicitly out.
 *
 * The *per-dispensary* staff role is on `ctx.staffRole` and is the
 * basis for any future intra-vendor permission gating (e.g. only
 * `manager`/`owner` may change `priceCents`). Today every staffed user
 * who can hit the route can perform every operation — narrowing happens
 * in the service, not the controller.
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
import { CurrentDispensary } from './current-dispensary.decorator.js';
import { CreateListingRequestDto, PatchListingRequestDto } from './dto/index.js';
import { VendorContextGuard } from './vendor-context.guard.js';
import { VendorListingsService } from './vendor-listings.service.js';
import type { ListingListResponse, ListingResponse } from './dto/index.js';
import type { VendorContext } from './vendor-context.types.js';

@Controller('vendor/listings')
@UseGuards(VendorContextGuard, RolesGuard)
@Roles('budtender', 'manager', 'owner', 'admin', 'superadmin')
export class VendorListingsController {
  constructor(private readonly listings: VendorListingsService) {}

  @Get()
  @RateLimit({ name: 'vendor-listing-list', tracker: 'user', limit: 120, windowMs: 60_000 })
  list(@CurrentDispensary() ctx: VendorContext): Promise<ListingListResponse> {
    return this.listings.list(ctx);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'vendor-listing-create', tracker: 'user', limit: 60, windowMs: 60_000 })
  create(
    @CurrentDispensary() ctx: VendorContext,
    @Body() body: CreateListingRequestDto,
  ): Promise<ListingResponse> {
    return this.listings.create(ctx, body);
  }

  @Patch(':id')
  @RateLimit({ name: 'vendor-listing-patch', tracker: 'user', limit: 120, windowMs: 60_000 })
  patch(
    @CurrentDispensary() ctx: VendorContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: PatchListingRequestDto,
  ): Promise<ListingResponse> {
    return this.listings.patch(ctx, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit({ name: 'vendor-listing-delete', tracker: 'user', limit: 60, windowMs: 60_000 })
  delete(
    @CurrentDispensary() ctx: VendorContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    return this.listings.delete(ctx, id);
  }
}
