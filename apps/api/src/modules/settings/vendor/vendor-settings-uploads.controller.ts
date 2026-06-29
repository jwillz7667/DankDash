/**
 * /v1/vendor/settings/image-uploads — presigned-upload surface for vendor
 * brand assets (storefront hero + logo).
 *
 *   POST /v1/vendor/settings/image-uploads — returns a presigned R2 POST the
 *   portal uses to upload one brand image directly to object storage. The
 *   returned `objectKey` is then sent back in a PATCH to /v1/vendor/settings
 *   ({ heroImageKey } or { logoImageKey }) to attach it to the storefront.
 *
 * Kept as a separate controller from VendorSettingsController (same base
 * path) so the settings service stays free of the storage dependency — the
 * two concerns wire independently, mirroring how listing uploads split from
 * the listings service.
 *
 * Guard stack matches the rest of /v1/vendor/settings: JwtAuthGuard (global)
 * authenticates, VendorContextGuard binds the dispensary from the
 * X-Dispensary-Id header against `dispensary_staff`, and RolesGuard narrows
 * to manager+ — brand is store-identity, not day-to-day inventory, so
 * budtenders are excluded (same bar as editing hours/branding). The minted
 * key is scoped to `ctx.dispensaryId`, so a staffed user can only ever mint
 * keys for the dispensary it staffs.
 */
import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { RateLimit } from '../../../common/decorators/rate-limit.decorator.js';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { CurrentDispensary } from '../../listings/vendor/current-dispensary.decorator.js';
import { ImageUploadRequestDto } from '../../listings/vendor/dto/image-upload.dto.js';
import { VendorContextGuard } from '../../listings/vendor/vendor-context.guard.js';
import { VendorSettingsUploadsService } from './vendor-settings-uploads.service.js';
import type { ImageUploadResponse } from '../../listings/vendor/dto/image-upload.dto.js';
import type { VendorContext } from '../../listings/vendor/vendor-context.types.js';

@Controller('vendor/settings')
@UseGuards(VendorContextGuard, RolesGuard)
@Roles('manager', 'owner', 'admin', 'superadmin')
export class VendorSettingsUploadsController {
  constructor(private readonly uploads: VendorSettingsUploadsService) {}

  @Post('image-uploads')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'vendor-brand-image-upload', tracker: 'user', limit: 30, windowMs: 60_000 })
  createUpload(
    @CurrentDispensary() ctx: VendorContext,
    @Body() body: ImageUploadRequestDto,
  ): Promise<ImageUploadResponse> {
    return this.uploads.createUpload(ctx, body);
  }
}
