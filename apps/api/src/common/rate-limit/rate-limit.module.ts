/**
 * RateLimitModule — wires the storage backend the global RateLimitGuard
 * depends on.
 *
 * In production (any non-test NODE_ENV) the Redis-backed implementation
 * is bound to RATE_LIMIT_STORE. In tests we bind an in-memory store so
 * the test rig never hits the network — the Memory impl mirrors the
 * fixed-window semantics exactly, so the guard's behaviour is identical
 * across environments.
 *
 * The guard itself is registered globally in main.ts (via
 * `app.useGlobalGuards(...)`) — same path JwtAuthGuard takes. Keeping the
 * binding outside @Module providers ensures the guard runs against every
 * request, including those handled by controllers that haven't imported
 * RateLimitModule.
 *
 * @Global so the RATE_LIMIT_STORE token is visible everywhere without
 * each feature module re-importing.
 */
import { loadEnv } from '@dankdash/config';
import { Global, Module, type FactoryProvider } from '@nestjs/common';
import { REDIS_CLIENT, RedisModule, type RedisClient } from '../../infrastructure/redis.module.js';
import {
  MemoryRateLimitStore,
  RATE_LIMIT_STORE,
  RedisRateLimitStore,
  type RateLimitStore,
} from './rate-limit-store.js';

const storeProvider: FactoryProvider<RateLimitStore> = {
  provide: RATE_LIMIT_STORE,
  inject: [REDIS_CLIENT],
  useFactory: (redis: RedisClient): RateLimitStore => {
    const env = loadEnv();
    if (env.NODE_ENV === 'test') {
      return new MemoryRateLimitStore();
    }
    return new RedisRateLimitStore(redis);
  },
};

@Global()
@Module({
  imports: [RedisModule],
  providers: [storeProvider],
  exports: [RATE_LIMIT_STORE],
})
export class RateLimitModule {}
