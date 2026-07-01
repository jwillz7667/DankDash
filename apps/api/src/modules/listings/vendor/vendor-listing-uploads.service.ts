/**
 * Mints presigned R2 uploads for vendor listing images.
 *
 * Flow: the portal asks for an upload slot → this service generates a key
 * under the dispensary's own prefix and returns a presigned POST policy → the
 * browser uploads the file straight to R2 → the portal PATCHes the listing's
 * `imageKeys` with the returned `objectKey`. VendorListingsService then
 * re-validates that key sits under the dispensary's prefix before persisting,
 * so a forged PATCH can never bind a listing to a foreign object.
 *
 * The key carries the dispensary id (tenant scope), the `listings/` segment
 * (asset class), and a UUIDv7 (collision-free, time-sortable). The extension
 * is derived from the locked content type so the stored object is servable
 * with a correct type from the public bucket.
 */
import { R2Storage } from '@dankdash/storage';
import { ValidationError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { dispensaryListingImagePrefix } from './listing-image-keys.js';
import type { ImageUploadRequest, ImageUploadResponse } from './dto/image-upload.dto.js';
import type { VendorContext } from './vendor-context.types.js';

/** 5 MiB — comfortably fits a high-res product photo; the R2 policy rejects larger. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// `Partial` so the indexed lookup is typed `string | undefined` — the
// runtime guard below is then meaningful (and lint-clean), catching any
// future enum/map drift instead of leaking an `undefined` extension.
const CONTENT_TYPE_EXTENSIONS: Partial<
  Readonly<Record<ImageUploadRequest['contentType'], string>>
> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

@Injectable()
export class VendorListingUploadsService {
  constructor(private readonly storage: R2Storage) {}

  async createUpload(ctx: VendorContext, body: ImageUploadRequest): Promise<ImageUploadResponse> {
    const extension = CONTENT_TYPE_EXTENSIONS[body.contentType];
    // The enum constrains contentType to a key of the map, so the lookup is
    // always defined; the guard turns any future enum/map drift into a clean
    // 422 instead of an `undefined` extension leaking into the key.
    if (extension === undefined) {
      throw new ValidationError('unsupported image content type', {
        contentType: body.contentType,
      });
    }

    const objectKey = `${dispensaryListingImagePrefix(ctx.dispensaryId)}${uuidv7()}.${extension}`;
    const presigned = await this.storage.presignUpload({
      key: objectKey,
      contentType: body.contentType,
      contentLengthMax: MAX_IMAGE_BYTES,
    });

    return {
      uploadUrl: presigned.url,
      method: presigned.method,
      // Spread to a fresh mutable record — the adapter returns a readonly view.
      headers: { ...presigned.headers },
      objectKey,
      expiresAt: presigned.expiresAt.toISOString(),
    };
  }
}
