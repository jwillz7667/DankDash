/**
 * Storage module — owns the single `R2Storage` adapter the API uses to mint
 * presigned uploads and (eventually) presigned downloads for restricted
 * assets.
 *
 * Like the Veriff client, only the I/O surface lives here; callers that mint
 * tenant-scoped object keys (e.g. VendorListingUploadsService) own the key
 * layout and validation. Centralizing the adapter keeps credential plumbing
 * in one place and lets a future provider swap touch one module.
 *
 * `R2_PUBLIC_BASE_URL` is optional in the validated env (a bucket may be
 * presign-only). We attach it only when present so we never assign
 * `undefined` into the readonly optional slot under `exactOptionalPropertyTypes`.
 */
import { R2Storage, type R2Config } from '@dankdash/storage';
import { Module, type FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const r2StorageProvider: FactoryProvider<R2Storage> = {
  provide: R2Storage,
  inject: [ConfigService],
  useFactory: (config: ConfigService): R2Storage => {
    const cfg: { -readonly [K in keyof R2Config]: R2Config[K] } = {
      accountId: config.getOrThrow<string>('R2_ACCOUNT_ID'),
      accessKeyId: config.getOrThrow<string>('R2_ACCESS_KEY_ID'),
      secretAccessKey: config.getOrThrow<string>('R2_SECRET_ACCESS_KEY'),
      bucket: config.getOrThrow<string>('R2_BUCKET_NAME'),
    };
    const publicBaseUrl = config.get<string>('R2_PUBLIC_BASE_URL');
    if (publicBaseUrl !== undefined) cfg.publicBaseUrl = publicBaseUrl;
    return new R2Storage(cfg);
  },
};

@Module({
  providers: [r2StorageProvider],
  exports: [R2Storage],
})
export class StorageModule {}
