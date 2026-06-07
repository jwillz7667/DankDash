/**
 * /v1/vendor/listings/image-uploads — presigned-upload surface for vendor
 * listing photos.
 *
 *   POST /v1/vendor/listings/image-uploads — returns a presigned R2 POST the
 *   portal uses to upload one product image directly to object storage. The
 *   returned `objectKey` is then sent back in a PATCH to
 *   /v1/vendor/listings/:id to attach the image to the listing.
 *
 * Kept as a separate controller from VendorListingsController (same base path)
 * so the listings service stays free of the storage dependency — the two
 * concerns wire independently. The same guard stack applies: JwtAuthGuard
 * (global) authenticates, VendorContextGuard binds the dispensary from the
 * X-Dispensary-Id header against `dispensary_staff`, and RolesGuard narrows
 * to staff/admin roles. The minted key is scoped to `ctx.dispensaryId`, so a
 * staffed user can only ever mint keys for the dispensary it staffs.
 */
import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { RateLimit } from '../../../common/decorators/rate-limit.decorator.js';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { CurrentDispensary } from './current-dispensary.decorator.js';
import { ImageUploadRequestDto } from './dto/image-upload.dto.js';
import { VendorContextGuard } from './vendor-context.guard.js';
import { VendorListingUploadsService } from './vendor-listing-uploads.service.js';
import type { ImageUploadResponse } from './dto/image-upload.dto.js';
import type { VendorContext } from './vendor-context.types.js';

@Controller('vendor/listings')
@UseGuards(VendorContextGuard, RolesGuard)
@Roles('budtender', 'manager', 'owner', 'admin', 'superadmin')
export class VendorListingUploadsController {
  constructor(private readonly uploads: VendorListingUploadsService) {}

  @Post('image-uploads')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'vendor-listing-image-upload', tracker: 'user', limit: 60, windowMs: 60_000 })
  createUpload(
    @CurrentDispensary() ctx: VendorContext,
    @Body() body: ImageUploadRequestDto,
  ): Promise<ImageUploadResponse> {
    return this.uploads.createUpload(ctx, body);
  }
}
