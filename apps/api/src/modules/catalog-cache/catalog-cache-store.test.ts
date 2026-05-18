/**
 * Unit tests for MemoryCatalogCacheStore.
 *
 * The RedisCatalogCacheStore is exercised end-to-end in the Phase 4.8
 * integration suite (real Redis via docker-compose) — that test path
 * verifies the wire format, EX TTL, and fail-open semantics against a
 * live server. Here we cover the in-memory implementation that the unit
 * tests of every catalog feature depend on: TTL semantics, lazy
 * eviction, and the get/set/del contract.
 *
 * The store interface returns `unknown` from `get`; the typed cast at
 * the call site is the same pattern CatalogCacheService.readThrough
 * uses, so the tests exercise the cast path that production runs on.
 */
import { describe, expect, it } from 'vitest';
import { MemoryCatalogCacheStore } from './catalog-cache-store.js';

interface Sample {
  readonly id: string;
  readonly count: number;
}

async function getAs<T>(store: MemoryCatalogCacheStore, key: string): Promise<T | null> {
  return (await store.get(key)) as T | null;
}

describe('MemoryCatalogCacheStore', () => {
  it('returns null on a key that was never written', async () => {
    const store = new MemoryCatalogCacheStore();
    expect(await getAs<Sample>(store, 'missing')).toBeNull();
  });

  it('round-trips a value through JSON', async () => {
    const store = new MemoryCatalogCacheStore();
    const value: Sample = { id: 'a', count: 42 };

    await store.set('k', value, 60);

    expect(await getAs<Sample>(store, 'k')).toEqual(value);
  });

  it('expires entries once the wall clock crosses the TTL boundary', async () => {
    let now = 1_000;
    const store = new MemoryCatalogCacheStore(() => now);
    await store.set('k', { id: 'a', count: 1 }, 60);

    now = 1_000 + 59_999;
    expect(await getAs<Sample>(store, 'k')).toEqual({ id: 'a', count: 1 });

    now = 1_000 + 60_000;
    expect(await getAs<Sample>(store, 'k')).toBeNull();
  });

  it('evicts expired entries on read so the Map does not grow unbounded', async () => {
    let now = 0;
    const store = new MemoryCatalogCacheStore(() => now);
    await store.set('k', { id: 'a', count: 1 }, 1);
    expect(store.size()).toBe(1);

    now = 1_500;
    await store.get('k');

    expect(store.size()).toBe(0);
  });

  it('overwrites an existing key with a fresh TTL', async () => {
    let now = 0;
    const store = new MemoryCatalogCacheStore(() => now);
    await store.set('k', { id: 'a', count: 1 }, 10);

    now = 5_000;
    await store.set('k', { id: 'a', count: 2 }, 10);

    now = 14_000;
    expect(await getAs<Sample>(store, 'k')).toEqual({ id: 'a', count: 2 });

    now = 16_000;
    expect(await getAs<Sample>(store, 'k')).toBeNull();
  });

  it('del() drops a single key', async () => {
    const store = new MemoryCatalogCacheStore();
    await store.set('a', { id: 'x', count: 1 }, 60);

    await store.del(['a']);

    expect(await getAs<Sample>(store, 'a')).toBeNull();
  });

  it('del() drops multiple keys atomically from the caller view', async () => {
    const store = new MemoryCatalogCacheStore();
    await store.set('a', { id: 'x', count: 1 }, 60);
    await store.set('b', { id: 'y', count: 2 }, 60);
    await store.set('c', { id: 'z', count: 3 }, 60);

    await store.del(['a', 'b']);

    expect(await getAs<Sample>(store, 'a')).toBeNull();
    expect(await getAs<Sample>(store, 'b')).toBeNull();
    expect(await getAs<Sample>(store, 'c')).toEqual({ id: 'z', count: 3 });
  });

  it('del() with an empty key list is a no-op', async () => {
    const store = new MemoryCatalogCacheStore();
    await store.set('a', { id: 'x', count: 1 }, 60);

    await store.del([]);

    expect(await getAs<Sample>(store, 'a')).toEqual({ id: 'x', count: 1 });
  });

  it('del() on a missing key is silently ignored', async () => {
    const store = new MemoryCatalogCacheStore();
    await expect(store.del(['ghost'])).resolves.toBeUndefined();
  });

  it('reset() clears the entire store', async () => {
    const store = new MemoryCatalogCacheStore();
    await store.set('a', { id: 'x', count: 1 }, 60);
    await store.set('b', { id: 'y', count: 2 }, 60);

    store.reset();

    expect(store.size()).toBe(0);
    expect(await getAs<Sample>(store, 'a')).toBeNull();
  });

  it('isolates arrays at write time so post-write mutation does not leak (JSON snapshot)', async () => {
    const store = new MemoryCatalogCacheStore();
    const items: string[] = ['x', 'y'];
    await store.set('k', { items }, 60);

    items.push('z');

    const out = await getAs<{ items: string[] }>(store, 'k');
    expect(out?.items).toEqual(['x', 'y']);
  });
});
