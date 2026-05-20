/**
 * RedisNotificationDedupeStore unit tests.
 *
 * The store is a thin wrapper around `SET key value EX ttl NX`. The contract
 * we pin here is the exact ioredis call shape (so a typo in the option order
 * — which silently degrades the atomicity guarantee — is caught) and the
 * 'OK' vs null translation that drives the dispatcher's skip path.
 */
import { describe, expect, it } from 'vitest';
import {
  RedisNotificationDedupeStore,
  type NotificationDedupeStore,
} from './notification-dedupe.store.js';
import type { Redis } from 'ioredis';

class FakeRedis {
  calls: Array<readonly unknown[]> = [];
  responses: Array<'OK' | null> = [];

  set = (...args: readonly unknown[]): Promise<'OK' | null> => {
    this.calls.push(args);
    const next = this.responses.shift();
    if (next === undefined) {
      throw new TypeError('no queued redis response');
    }
    return Promise.resolve(next);
  };
}

describe('RedisNotificationDedupeStore', () => {
  it('returns true when SET NX acquires the key', async () => {
    const redis = new FakeRedis();
    redis.responses = ['OK'];
    const store: NotificationDedupeStore = new RedisNotificationDedupeStore(
      redis as unknown as Redis,
    );

    const ok = await store.acquire('user-1:order.accepted:order-1:accepted', 86_400);

    expect(ok).toBe(true);
    expect(redis.calls).toEqual([
      ['notif:dedupe:user-1:order.accepted:order-1:accepted', '1', 'EX', 86_400, 'NX'],
    ]);
  });

  it('returns false when SET NX rejects (key already exists)', async () => {
    const redis = new FakeRedis();
    redis.responses = [null];
    const store: NotificationDedupeStore = new RedisNotificationDedupeStore(
      redis as unknown as Redis,
    );

    const ok = await store.acquire('user-1:order.accepted:order-1:accepted', 86_400);

    expect(ok).toBe(false);
  });

  it('honors a custom key prefix', async () => {
    const redis = new FakeRedis();
    redis.responses = ['OK'];
    const store = new RedisNotificationDedupeStore(redis as unknown as Redis, 'test:dedupe:');

    await store.acquire('k', 60);

    expect(redis.calls[0]?.[0]).toBe('test:dedupe:k');
  });

  it('passes the TTL through verbatim (no clamping or unit conversion)', async () => {
    const redis = new FakeRedis();
    redis.responses = ['OK'];
    const store = new RedisNotificationDedupeStore(redis as unknown as Redis);

    await store.acquire('k', 1);

    expect(redis.calls[0]).toEqual(['notif:dedupe:k', '1', 'EX', 1, 'NX']);
  });
});
