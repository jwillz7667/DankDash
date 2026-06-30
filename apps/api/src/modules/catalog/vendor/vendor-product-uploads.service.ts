/**
 * Mints presigned R2 uploads for vendor-authored product images.
 *
 * Identical contract to the listing/brand uploaders: mint a presigned POST
 * under the dispensary's own `products/` prefix, the browser uploads straight
 * to R2, then the returned `objectKey` is persisted on the product's
 * `imageKeys` via PATCH /v1/vendor/products/:id — where VendorProductsService
 * re-validates the key is owned by the dispensary before storing it.
 */
import { R2Storage } from '@dankdash/storage';
import { ValidationError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { dispensaryProductImagePrefix } from './vendor-product-image-keys.js';
import type {
  ImageUploadRequest,
  ImageUploadResponse,
} from '../../listings/vendor/dto/image-upload.dto.js';
import type { VendorContext } from '../../listings/vendor/vendor-context.types.js';

/** 5 MiB — fits a high-res product photo; the R2 policy rejects larger. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const CONTENT_TYPE_EXTENSIONS: Partial<
  Readonly<Record<ImageUploadRequest['contentType'], string>>
> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

@Injectable()
export class VendorProductUploadsService {
  constructor(private readonly storage: R2Storage) {}

  async createUpload(ctx: VendorContext, body: ImageUploadRequest): Promise<ImageUploadResponse> {
    const extension = CONTENT_TYPE_EXTENSIONS[body.contentType];
    if (extension === undefined) {
      throw new ValidationError('unsupported image content type', {
        contentType: body.contentType,
      });
    }

    const objectKey = `${dispensaryProductImagePrefix(ctx.dispensaryId)}${uuidv7()}.${extension}`;
    const presigned = await this.storage.presignUpload({
      key: objectKey,
      contentType: body.contentType,
      contentLengthMax: MAX_IMAGE_BYTES,
    });

    return {
      uploadUrl: presigned.url,
      fields: { ...presigned.fields },
      objectKey,
      expiresAt: presigned.expiresAt.toISOString(),
    };
  }
}
