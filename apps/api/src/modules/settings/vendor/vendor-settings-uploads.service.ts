/**
 * Mints presigned R2 uploads for vendor brand assets (storefront hero +
 * logo).
 *
 * Flow mirrors the listing-image uploader: the portal asks for an upload
 * slot → this service generates a key under the dispensary's own `brand/`
 * prefix and returns a presigned POST policy → the browser uploads the file
 * straight to R2 → the portal PATCHes the dispensary's `heroImageKey` /
 * `logoImageKey` with the returned `objectKey`. VendorSettingsService then
 * re-validates that key is owned by the dispensary before persisting, so a
 * forged PATCH can never bind a storefront to a foreign object.
 *
 * The key carries the dispensary id (tenant scope), the `brand/` segment
 * (asset class), and a UUIDv7 (collision-free, time-sortable). The
 * extension is derived from the locked content type so the stored object is
 * servable with a correct type from the public bucket.
 *
 * The upload DTO + content-type enum are shared with the listing uploader —
 * the presign contract is identical, so the two surfaces stay in lockstep
 * rather than drifting two copies of the same shape.
 */
import { R2Storage } from '@dankdash/storage';
import { ValidationError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { dispensaryBrandImagePrefix } from './brand-image-keys.js';
import type {
  ImageUploadRequest,
  ImageUploadResponse,
} from '../../listings/vendor/dto/image-upload.dto.js';
import type { VendorContext } from '../../listings/vendor/vendor-context.types.js';

/** 5 MiB — comfortably fits a high-res storefront hero; the R2 policy rejects larger. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// `Partial` so the indexed lookup is typed `string | undefined` — the runtime
// guard below is then meaningful (and lint-clean), catching any future
// enum/map drift instead of leaking an `undefined` extension.
const CONTENT_TYPE_EXTENSIONS: Partial<
  Readonly<Record<ImageUploadRequest['contentType'], string>>
> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

@Injectable()
export class VendorSettingsUploadsService {
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

    const objectKey = `${dispensaryBrandImagePrefix(ctx.dispensaryId)}${uuidv7()}.${extension}`;
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
