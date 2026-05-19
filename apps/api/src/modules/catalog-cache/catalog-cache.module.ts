/**
 * CatalogCacheModule — wires the storage backend and exposes the cache
 * service as a global, importable singleton.
 *
 * Test runs (NODE_ENV=test) bind the in-memory store so the suite never
 * touches Redis; production runs bind the Redis-backed store using the
 * shared REDIS_CLIENT from RedisModule. Both implementations satisfy the
 * same CatalogCacheStore interface, so the service above is agnostic.
 *
 * `@Global` because the cache is consumed from two feature modules
 * (dispensaries, listings) and a third in the future (search) — each
 * pulling in CatalogCacheModule by name would be ceremony for no gain.
 * The pattern mirrors RateLimitModule, which is also @Global for the
 * same reason.
 */
import { loadEnv } from '@dankdash/config';
import { Global, Module, type FactoryProvider } from '@nestjs/common';
import { REDIS_CLIENT, RedisModule, type RedisClient } from '../../infrastructure/redis.module.js';
import {
  CATALOG_CACHE_STORE,
  MemoryCatalogCacheStore,
  RedisCatalogCacheStore,
  type CatalogCacheStore,
} from './catalog-cache-store.js';
import { CatalogCacheService } from './catalog-cache.service.js';

const storeProvider: FactoryProvider<CatalogCacheStore> = {
  provide: CATALOG_CACHE_STORE,
  inject: [REDIS_CLIENT],
  useFactory: (redis: RedisClient): CatalogCacheStore => {
    const env = loadEnv();
    if (env.NODE_ENV === 'test') {
      return new MemoryCatalogCacheStore();
    }
    return new RedisCatalogCacheStore(redis);
  },
};

@Global()
@Module({
  imports: [RedisModule],
  providers: [storeProvider, CatalogCacheService],
  exports: [CatalogCacheService, CATALOG_CACHE_STORE],
})
export class CatalogCacheModule {}
