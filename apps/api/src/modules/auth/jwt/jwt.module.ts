/**
 * JWT + refresh-token module. Reads RS256 key material and TTLs from env,
 * wires JwtService for access tokens and RefreshTokenService for the
 * rotation chain. Both export so AuthService (next phase) can compose them.
 */
import { SessionsRepository, type Database } from '@dankdash/db';
import { ConfigError } from '@dankdash/types';
import { Module, type FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DRIZZLE_DB } from '../../../infrastructure/drizzle.module.js';
import { JwtService, type JwtServiceConfig } from './jwt.service.js';
import { RefreshTokenService } from './refresh-token.service.js';

function decodeBase64Pem(value: string, name: string): string {
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  // Reject the obvious "they pasted the PEM body without base64-encoding it"
  // failure mode at boot — easier to debug than a verify-time signature error.
  if (!decoded.includes('-----BEGIN')) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `${name} did not decode to a PEM-formatted key — verify the value is base64 of a -----BEGIN ... PEM block`,
      { variable: name },
    );
  }
  return decoded;
}

const jwtServiceProvider: FactoryProvider<JwtService> = {
  provide: JwtService,
  inject: [ConfigService],
  useFactory: (config: ConfigService): JwtService => {
    const cfg: JwtServiceConfig = {
      privateKeyPem: decodeBase64Pem(
        config.getOrThrow<string>('JWT_PRIVATE_KEY_BASE64'),
        'JWT_PRIVATE_KEY_BASE64',
      ),
      publicKeyPem: decodeBase64Pem(
        config.getOrThrow<string>('JWT_PUBLIC_KEY_BASE64'),
        'JWT_PUBLIC_KEY_BASE64',
      ),
      accessTtlSeconds: Number(config.getOrThrow<string | number>('JWT_ACCESS_TTL_SECONDS')),
    };
    return new JwtService(cfg);
  },
};

const sessionsRepoProvider: FactoryProvider<SessionsRepository> = {
  provide: SessionsRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): SessionsRepository => new SessionsRepository(db),
};

const refreshTokenServiceProvider: FactoryProvider<RefreshTokenService> = {
  provide: RefreshTokenService,
  inject: [ConfigService, SessionsRepository],
  useFactory: (config: ConfigService, sessions: SessionsRepository): RefreshTokenService =>
    new RefreshTokenService(sessions, {
      refreshTtlSeconds: Number(config.getOrThrow<string | number>('JWT_REFRESH_TTL_SECONDS')),
    }),
};

@Module({
  providers: [sessionsRepoProvider, jwtServiceProvider, refreshTokenServiceProvider],
  exports: [JwtService, RefreshTokenService, SessionsRepository],
})
export class AuthJwtModule {}
