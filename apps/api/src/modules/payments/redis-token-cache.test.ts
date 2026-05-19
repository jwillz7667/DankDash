/**
 * RedisTokenCache adapter unit tests.
 *
 * The adapter is a 3-method passthrough — the only meaningful coverage is
 * pinning the ioredis call shapes so a future refactor (e.g. switching to
 * `SET key value EX ttl NX` or another mode) is caught against the
 * Aeropay-side contract that AeropayAuth depends on.
 */
import { describe, expect, it } from 'vitest';
import { RedisTokenCache, type RedisLikeForTokenCache } from './redis-token-cache.js';

interface GetCall {
  readonly key: string;
}
interface SetCall {
  readonly key: string;
  readonly value: string;
  readonly mode: 'EX';
  readonly ttlSeconds: number;
}
interface DelCall {
  readonly key: string;
}

class FakeRedis implements RedisLikeForTokenCache {
  readonly gets: GetCall[] = [];
  readonly sets: SetCall[] = [];
  readonly dels: DelCall[] = [];
  private readonly store = new Map<string, string>();

  get = (key: string): Promise<string | null> => {
    this.gets.push({ key });
    return Promise.resolve(this.store.get(key) ?? null);
  };

  set = (key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<'OK' | null> => {
    this.sets.push({ key, value, mode, ttlSeconds });
    this.store.set(key, value);
    return Promise.resolve('OK');
  };

  del = (key: string): Promise<number> => {
    this.dels.push({ key });
    return Promise.resolve(this.store.delete(key) ? 1 : 0);
  };
}

describe('RedisTokenCache', () => {
  it('get returns the cached value via redis.get(key)', async () => {
    const redis = new FakeRedis();
    await redis.set('k', 'v', 'EX', 60);
    const cache = new RedisTokenCache(redis);

    const value = await cache.get('k');

    expect(value).toBe('v');
    expect(redis.gets).toEqual([{ key: 'k' }]);
  });

  it('get returns null on a cache miss', async () => {
    const redis = new FakeRedis();
    const cache = new RedisTokenCache(redis);

    expect(await cache.get('missing')).toBeNull();
    expect(redis.gets).toEqual([{ key: 'missing' }]);
  });

  it('set issues SET key value EX ttlSeconds', async () => {
    const redis = new FakeRedis();
    const cache = new RedisTokenCache(redis);

    await cache.set('aeropay:token:abc', '{"accessToken":"x"}', 1800);

    expect(redis.sets).toEqual([
      { key: 'aeropay:token:abc', value: '{"accessToken":"x"}', mode: 'EX', ttlSeconds: 1800 },
    ]);
  });

  it('del forwards the key to redis.del', async () => {
    const redis = new FakeRedis();
    await redis.set('k', 'v', 'EX', 60);
    const cache = new RedisTokenCache(redis);

    await cache.del('k');

    expect(redis.dels).toEqual([{ key: 'k' }]);
    expect(await cache.get('k')).toBeNull();
  });

  it('del on a missing key is a no-op (does not throw)', async () => {
    const redis = new FakeRedis();
    const cache = new RedisTokenCache(redis);

    await expect(cache.del('does-not-exist')).resolves.toBeUndefined();
    expect(redis.dels).toEqual([{ key: 'does-not-exist' }]);
  });
});
