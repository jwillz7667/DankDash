/**
 * Column-encryption infrastructure module.
 *
 * Exposes a single global EncryptionService instance built from the master
 * key in `COLUMN_ENCRYPTION_KEY_BASE64`. Marked `@Global()` so feature
 * modules (auth/mfa today, dispensary credentials in Phase 5) can inject the
 * `ENCRYPTION_SERVICE` token without re-declaring the provider.
 *
 * The master key is loaded once at app init. Key rotation is a deploy event
 * (new key → backfill re-encrypts existing columns under the new key), not a
 * runtime concern.
 */
import { createEncryptionServiceFromBase64, type EncryptionService } from '@dankdash/db';
import { Global, Module, type FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const ENCRYPTION_SERVICE = Symbol.for('ENCRYPTION_SERVICE');

const encryptionProvider: FactoryProvider<EncryptionService> = {
  provide: ENCRYPTION_SERVICE,
  inject: [ConfigService],
  useFactory: (config: ConfigService): EncryptionService =>
    createEncryptionServiceFromBase64(config.getOrThrow<string>('COLUMN_ENCRYPTION_KEY_BASE64')),
};

@Global()
@Module({
  providers: [encryptionProvider],
  exports: [ENCRYPTION_SERVICE],
})
export class EncryptionModule {}
