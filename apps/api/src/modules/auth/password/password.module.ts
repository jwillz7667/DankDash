/**
 * Auth/Password module — exposes `PasswordService` as an injectable bound
 * to the live `PASSWORD_PEPPER` from `ConfigService`. Imported by the
 * Auth module (next phase); other modules should not import this directly,
 * since password material is a sensitive boundary.
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PasswordService } from './password.service.js';

@Module({
  providers: [
    {
      provide: PasswordService,
      inject: [ConfigService],
      useFactory: (config: ConfigService): PasswordService =>
        new PasswordService({ pepper: config.getOrThrow<string>('PASSWORD_PEPPER') }),
    },
  ],
  exports: [PasswordService],
})
export class PasswordModule {}
