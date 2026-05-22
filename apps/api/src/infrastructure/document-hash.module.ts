/**
 * Document-number hashing infrastructure module.
 *
 * Exposes a single global DocumentHasher instance built from the pepper
 * in `DOCUMENT_HASH_PEPPER_BASE64`. Marked `@Global()` so feature modules
 * (drivers admin today; identity ID-document onboarding next) can inject
 * the `DOCUMENT_HASHER` token without re-declaring the provider.
 *
 * The pepper is loaded once at app init. Pepper rotation is a deploy
 * event coordinated with a backfill that re-hashes every existing row
 * under the new pepper — not a runtime concern.
 */
import { createDocumentHasherFromBase64, type DocumentHasher } from '@dankdash/db';
import { Global, Module, type FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const DOCUMENT_HASHER = Symbol.for('DOCUMENT_HASHER');

const documentHasherProvider: FactoryProvider<DocumentHasher> = {
  provide: DOCUMENT_HASHER,
  inject: [ConfigService],
  useFactory: (config: ConfigService): DocumentHasher =>
    createDocumentHasherFromBase64(config.getOrThrow<string>('DOCUMENT_HASH_PEPPER_BASE64')),
};

@Global()
@Module({
  providers: [documentHasherProvider],
  exports: [DOCUMENT_HASHER],
})
export class DocumentHashModule {}
