/**
 * MFA TOTP module. Wires MfaService with the shared UsersRepository and the
 * global EncryptionService (token from EncryptionModule). The issuer string
 * defaults to "DankDash" but can be overridden via the optional
 * `MFA_ISSUER` env var for branded white-label tenants in the future.
 */
import { UsersRepository, type Database, type EncryptionService } from '@dankdash/db';
import { Module, type FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DRIZZLE_DB } from '../../../infrastructure/drizzle.module.js';
import { ENCRYPTION_SERVICE } from '../../../infrastructure/encryption.module.js';
import { MfaService, type MfaServiceConfig } from './mfa.service.js';

const usersRepoProvider: FactoryProvider<UsersRepository> = {
  provide: UsersRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): UsersRepository => new UsersRepository(db),
};

const mfaServiceProvider: FactoryProvider<MfaService> = {
  provide: MfaService,
  inject: [UsersRepository, ENCRYPTION_SERVICE, ConfigService],
  useFactory: (
    users: UsersRepository,
    encryption: EncryptionService,
    config: ConfigService,
  ): MfaService => {
    const cfg: MfaServiceConfig = {};
    const issuer = config.get<string>('MFA_ISSUER');
    if (issuer !== undefined && issuer.length > 0) {
      Object.assign(cfg, { issuer });
    }
    return new MfaService(users, encryption, cfg);
  },
};

@Module({
  providers: [usersRepoProvider, mfaServiceProvider],
  exports: [MfaService, UsersRepository],
})
export class MfaModule {}
