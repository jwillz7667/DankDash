/**
 * /v1/vendor/products/image-uploads — presigned-upload surface for vendor
 * product photos. Returns a presigned R2 POST; the returned objectKey is then
 * PATCHed onto a product's `imageKeys`. Same guard stack + manager+ gate as
 * the rest of /v1/vendor/products.
 */
import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { RateLimit } from '../../../common/decorators/rate-limit.decorator.js';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { CurrentDispensary } from '../../listings/vendor/current-dispensary.decorator.js';
import { ImageUploadRequestDto } from '../../listings/vendor/dto/image-upload.dto.js';
import { VendorContextGuard } from '../../listings/vendor/vendor-context.guard.js';
import { VendorProductUploadsService } from './vendor-product-uploads.service.js';
import type { ImageUploadResponse } from '../../listings/vendor/dto/image-upload.dto.js';
import type { VendorContext } from '../../listings/vendor/vendor-context.types.js';

@Controller('vendor/products')
@UseGuards(VendorContextGuard, RolesGuard)
@Roles('manager', 'owner', 'admin', 'superadmin')
export class VendorProductUploadsController {
  constructor(private readonly uploads: VendorProductUploadsService) {}

  @Post('image-uploads')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'vendor-product-image-upload', tracker: 'user', limit: 60, windowMs: 60_000 })
  createUpload(
    @CurrentDispensary() ctx: VendorContext,
    @Body() body: ImageUploadRequestDto,
  ): Promise<ImageUploadResponse> {
    return this.uploads.createUpload(ctx, body);
  }
}
