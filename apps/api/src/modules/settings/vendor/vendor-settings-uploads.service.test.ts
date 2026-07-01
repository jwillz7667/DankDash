/**
 * Unit tests for VendorSettingsUploadsService.
 *
 * The service mints a presigned R2 POST for one brand image (hero/logo). The
 * contract that matters for tenant isolation and a correct round-trip:
 *   - the minted object key sits under the caller's `brand/` prefix, so the
 *     persist-time validator in VendorSettingsService accepts it and no other
 *     dispensary's PATCH ever could;
 *   - the file extension is derived from the locked content type so the stored
 *     object is servable with a correct type;
 *   - the storage policy locks the content type and a 5 MiB size ceiling;
 *   - the response surfaces a fresh mutable `headers` map (the adapter returns a
 *     readonly view) and an ISO-8601 `expiresAt`.
 *
 * R2Storage is faked — these are pure unit tests with no network.
 */
import { ValidationError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { dispensaryBrandImagePrefix, isBrandImageKeyOwnedBy } from './brand-image-keys.js';
import { VendorSettingsUploadsService } from './vendor-settings-uploads.service.js';
import type { R2Storage, PresignUploadOptions, PresignedUpload } from '@dankdash/storage';
import type { ImageUploadRequest } from '../../listings/vendor/dto/image-upload.dto.js';
import type { VendorContext } from '../../listings/vendor/vendor-context.types.js';

const DISPENSARY_ID = '01935f3d-0000-7000-8000-000000000010';

const CTX: VendorContext = {
  dispensaryId: DISPENSARY_ID,
  userId: '01935f3d-0000-7000-8000-000000000001',
  staffRole: 'owner',
  staffMemberId: '01935f3d-0000-7000-8000-000000000050',
};

const EXPIRES_AT = new Date('2026-06-29T12:05:00.000Z');

class FakeR2Storage {
  public calls: PresignUploadOptions[] = [];

  presignUpload(opts: PresignUploadOptions): Promise<PresignedUpload> {
    this.calls.push(opts);
    return Promise.resolve({
      url: 'https://account.r2.cloudflarestorage.com/dankdash',
      method: 'PUT' as const,
      headers: Object.freeze({ 'Content-Type': opts.contentType }),
      expiresAt: EXPIRES_AT,
    });
  }
}

function makeService(): { service: VendorSettingsUploadsService; storage: FakeR2Storage } {
  const storage = new FakeR2Storage();
  const service = new VendorSettingsUploadsService(storage as unknown as R2Storage);
  return { service, storage };
}

describe('VendorSettingsUploadsService.createUpload', () => {
  it('mints a key under the caller dispensary brand prefix the validator will own', async () => {
    const { service } = makeService();

    const res = await service.createUpload(CTX, { contentType: 'image/jpeg' });

    expect(res.objectKey.startsWith(dispensaryBrandImagePrefix(DISPENSARY_ID))).toBe(true);
    expect(isBrandImageKeyOwnedBy(DISPENSARY_ID, res.objectKey)).toBe(true);
  });

  it.each([
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
    ['image/webp', 'webp'],
  ] as const)('derives the %s extension as .%s', async (contentType, ext) => {
    const { service } = makeService();

    const res = await service.createUpload(CTX, { contentType });

    expect(res.objectKey.endsWith(`.${ext}`)).toBe(true);
  });

  it('locks the content type and a 5 MiB size ceiling in the storage policy', async () => {
    const { service, storage } = makeService();

    await service.createUpload(CTX, { contentType: 'image/png' });

    expect(storage.calls).toHaveLength(1);
    const opts = storage.calls[0];
    expect(opts?.contentType).toBe('image/png');
    expect(opts?.contentLengthMax).toBe(5 * 1024 * 1024);
    expect(opts?.key).toMatch(/\.png$/u);
  });

  it('returns a PUT method, a fresh mutable headers map, and an ISO-8601 expiry', async () => {
    const { service } = makeService();

    const res = await service.createUpload(CTX, { contentType: 'image/webp' });

    expect(res.uploadUrl).toContain('r2.cloudflarestorage.com');
    expect(res.method).toBe('PUT');
    expect(res.headers['Content-Type']).toBe('image/webp');
    expect(res.expiresAt).toBe(EXPIRES_AT.toISOString());
    // Must not be the frozen adapter view — a later mutation must not throw.
    expect(() => {
      res.headers.extra = 'x';
    }).not.toThrow();
  });

  it('mints distinct keys across calls (UUIDv7 collision-free)', async () => {
    const { service } = makeService();

    const a = await service.createUpload(CTX, { contentType: 'image/jpeg' });
    const b = await service.createUpload(CTX, { contentType: 'image/jpeg' });

    expect(a.objectKey).not.toBe(b.objectKey);
  });

  it('rejects an unsupported content type that slipped past the DTO enum', async () => {
    const { service } = makeService();

    await expect(
      service.createUpload(CTX, { contentType: 'image/gif' } as unknown as ImageUploadRequest),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
