/**
 * Checkout-handoff module — wires `CheckoutHandoffService` with the same
 * FactoryProvider + scoped-repos pattern used by CartModule / OrdersModule.
 *
 * Imports DRIZZLE_DB (singleton) and REDIS_CLIENT (single-shot jti store),
 * and pulls RS256 key material + TTL + checkout base URL from ConfigService.
 * The RS256 key pair is intentionally reused from the access-token issuer
 * (one rotation policy) but the `aud` claim differs so the two surfaces
 * don't cross-validate — see `checkout-handoff.service.ts` header.
 *
 * AuthService is *not* a consumer of this service; AuthController calls it
 * directly. That avoids inflating AuthService's surface for a single
 * endpoint with no overlap with the password/MFA/session flows.
 */
import { CartsRepository, UserAddressesRepository, type Database } from '@dankdash/db';
import { ConfigError } from '@dankdash/types';
import { Module, type FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DRIZZLE_DB } from '../../../infrastructure/drizzle.module.js';
import { REDIS_CLIENT, type RedisClient } from '../../../infrastructure/redis.module.js';
import {
  CheckoutHandoffService,
  type CheckoutHandoffScopedRepos,
  type CheckoutHandoffServiceConfig,
} from './checkout-handoff.service.js';

function decodeBase64Pem(value: string, name: string): string {
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  if (!decoded.includes('-----BEGIN')) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `${name} did not decode to a PEM-formatted key — verify the value is base64 of a -----BEGIN ... PEM block`,
      { variable: name },
    );
  }
  return decoded;
}

const checkoutHandoffServiceProvider: FactoryProvider<CheckoutHandoffService> = {
  provide: CheckoutHandoffService,
  inject: [DRIZZLE_DB, REDIS_CLIENT, ConfigService],
  useFactory: (db: Database, redis: RedisClient, config: ConfigService): CheckoutHandoffService => {
    const cfg: CheckoutHandoffServiceConfig = {
      privateKeyPem: decodeBase64Pem(
        config.getOrThrow<string>('JWT_PRIVATE_KEY_BASE64'),
        'JWT_PRIVATE_KEY_BASE64',
      ),
      publicKeyPem: decodeBase64Pem(
        config.getOrThrow<string>('JWT_PUBLIC_KEY_BASE64'),
        'JWT_PUBLIC_KEY_BASE64',
      ),
      ttlSeconds: Number(config.getOrThrow<string | number>('CHECKOUT_HANDOFF_TTL_SECONDS')),
      checkoutBaseUrl: config.getOrThrow<string>('CHECKOUT_BASE_URL'),
    };
    return new CheckoutHandoffService(
      db,
      (scopedDb): CheckoutHandoffScopedRepos => ({
        carts: new CartsRepository(scopedDb),
        userAddresses: new UserAddressesRepository(scopedDb),
      }),
      redis,
      cfg,
    );
  },
};

@Module({
  providers: [checkoutHandoffServiceProvider],
  exports: [CheckoutHandoffService],
})
export class CheckoutHandoffModule {}
