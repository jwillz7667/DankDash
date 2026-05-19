/**
 * Unit tests for CatalogCacheService.
 *
 * The interesting behaviour to lock down is the read-through contract:
 * cache hit returns the stored value without calling the loader; cache
 * miss calls the loader, caches the result, and returns it; a loader
 * that returns null/undefined is NOT cached (so a transient miss does
 * not lock in for the TTL); invalidation drops the right keys for the
 * right surface (dispensary edits drop feed+menu, listing edits drop
 * menu only).
 *
 * A counting fake store stands in for Redis/Memory so we can assert
 * exact call counts without depending on TTL clock semantics — those
 * are covered separately in catalog-cache-store.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { type CatalogCacheStore } from './catalog-cache-store.js';
import {
  CACHE_VERSION,
  CATALOG_CACHE_TTL_SECONDS,
  CatalogCacheService,
} from './catalog-cache.service.js';

interface Feed {
  readonly dispensaries: readonly { readonly id: string }[];
}

interface Menu {
  readonly dispensaryId: string;
  readonly items: readonly string[];
}

class CountingStore implements CatalogCacheStore {
  public getCalls: string[] = [];
  public setCalls: { key: string; value: unknown; ttl: number }[] = [];
  public delCalls: string[][] = [];

  private readonly entries = new Map<string, string>();

  get(key: string): Promise<unknown> {
    this.getCalls.push(key);
    const raw = this.entries.get(key);
    if (raw === undefined) return Promise.resolve(null);
    return Promise.resolve(JSON.parse(raw));
  }

  set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    this.setCalls.push({ key, value, ttl: ttlSeconds });
    this.entries.set(key, JSON.stringify(value));
    return Promise.resolve();
  }

  del(keys: readonly string[]): Promise<void> {
    this.delCalls.push([...keys]);
    for (const k of keys) this.entries.delete(k);
    return Promise.resolve();
  }
}

const DISP_ID = '01935f3d-0000-7000-8000-000000000001';
const OTHER_DISP_ID = '01935f3d-0000-7000-8000-0000000000ff';

describe('CatalogCacheService.getDispensaryFeed', () => {
  it('invokes the loader on a cold cache, caches the result, returns it', async () => {
    const store = new CountingStore();
    const svc = new CatalogCacheService(store);
    const feed: Feed = { dispensaries: [{ id: DISP_ID }] };
    const loader = vi.fn().mockResolvedValue(feed);

    const res = await svc.getDispensaryFeed<Feed>(loader);

    expect(res).toEqual(feed);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(store.setCalls).toEqual([
      { key: `${CACHE_VERSION}:dispensary-feed`, value: feed, ttl: CATALOG_CACHE_TTL_SECONDS },
    ]);
  });

  it('serves a warm cache without calling the loader', async () => {
    const store = new CountingStore();
    const svc = new CatalogCacheService(store);
    const feed: Feed = { dispensaries: [{ id: DISP_ID }] };

    await svc.getDispensaryFeed<Feed>(() => Promise.resolve(feed));
    const loader = vi.fn().mockResolvedValue({ dispensaries: [] });
    const res = await svc.getDispensaryFeed<Feed>(loader);

    expect(res).toEqual(feed);
    expect(loader).not.toHaveBeenCalled();
  });

  it('does NOT cache a null loader result (avoids 60s poisoned tombstone)', async () => {
    const store = new CountingStore();
    const svc = new CatalogCacheService(store);

    const res = await svc.getDispensaryFeed<Feed | null>(() => Promise.resolve(null));

    expect(res).toBeNull();
    expect(store.setCalls).toEqual([]);
  });

  it('does NOT cache an undefined loader result', async () => {
    const store = new CountingStore();
    const svc = new CatalogCacheService(store);

    const res = await svc.getDispensaryFeed<Feed | undefined>(() => Promise.resolve(undefined));

    expect(res).toBeUndefined();
    expect(store.setCalls).toEqual([]);
  });

  it('propagates loader errors without writing to the cache', async () => {
    const store = new CountingStore();
    const svc = new CatalogCacheService(store);

    await expect(
      svc.getDispensaryFeed<Feed>(() => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    expect(store.setCalls).toEqual([]);
  });
});

describe('CatalogCacheService.getDispensaryMenu', () => {
  it('keys the cache per dispensaryId', async () => {
    const store = new CountingStore();
    const svc = new CatalogCacheService(store);
    const menu1: Menu = { dispensaryId: DISP_ID, items: ['a'] };
    const menu2: Menu = { dispensaryId: OTHER_DISP_ID, items: ['b'] };

    await svc.getDispensaryMenu<Menu>(DISP_ID, () => Promise.resolve(menu1));
    await svc.getDispensaryMenu<Menu>(OTHER_DISP_ID, () => Promise.resolve(menu2));

    expect(store.setCalls.map((c) => c.key)).toEqual([
      `${CACHE_VERSION}:dispensary-menu:${DISP_ID}`,
      `${CACHE_VERSION}:dispensary-menu:${OTHER_DISP_ID}`,
    ]);
  });

  it('serves a warm per-dispensary cache without invoking the loader', async () => {
    const store = new CountingStore();
    const svc = new CatalogCacheService(store);
    const menu: Menu = { dispensaryId: DISP_ID, items: ['x'] };

    await svc.getDispensaryMenu<Menu>(DISP_ID, () => Promise.resolve(menu));
    const loader = vi.fn().mockResolvedValue({ dispensaryId: DISP_ID, items: ['y'] });
    const res = await svc.getDispensaryMenu<Menu>(DISP_ID, loader);

    expect(res).toEqual(menu);
    expect(loader).not.toHaveBeenCalled();
  });
});

describe('CatalogCacheService.invalidateDispensary', () => {
  it('drops both the feed and the targeted dispensary menu keys', async () => {
    const store = new CountingStore();
    const svc = new CatalogCacheService(store);

    await svc.invalidateDispensary(DISP_ID);

    expect(store.delCalls).toEqual([
      [`${CACHE_VERSION}:dispensary-feed`, `${CACHE_VERSION}:dispensary-menu:${DISP_ID}`],
    ]);
  });

  it("does not touch other dispensaries' menu keys", async () => {
    const store = new CountingStore();
    const svc = new CatalogCacheService(store);
    const menu: Menu = { dispensaryId: OTHER_DISP_ID, items: ['z'] };
    await svc.getDispensaryMenu<Menu>(OTHER_DISP_ID, () => Promise.resolve(menu));

    await svc.invalidateDispensary(DISP_ID);

    const res = await svc.getDispensaryMenu<Menu>(OTHER_DISP_ID, () =>
      Promise.reject(new Error('loader should not run; expected cache hit')),
    );
    expect(res).toEqual(menu);
  });

  it('forces the next feed read to invoke the loader again', async () => {
    const store = new CountingStore();
    const svc = new CatalogCacheService(store);
    const feed: Feed = { dispensaries: [{ id: DISP_ID }] };

    await svc.getDispensaryFeed<Feed>(() => Promise.resolve(feed));
    await svc.invalidateDispensary(DISP_ID);

    const reloader = vi.fn().mockResolvedValue(feed);
    await svc.getDispensaryFeed<Feed>(reloader);

    expect(reloader).toHaveBeenCalledTimes(1);
  });
});

describe('CatalogCacheService.invalidateListing', () => {
  it('drops ONLY the menu key, leaving the feed cache intact', async () => {
    const store = new CountingStore();
    const svc = new CatalogCacheService(store);

    await svc.invalidateListing(DISP_ID);

    expect(store.delCalls).toEqual([[`${CACHE_VERSION}:dispensary-menu:${DISP_ID}`]]);
  });

  it('keeps the feed warm across a listing-edit invalidation', async () => {
    const store = new CountingStore();
    const svc = new CatalogCacheService(store);
    const feed: Feed = { dispensaries: [{ id: DISP_ID }] };
    await svc.getDispensaryFeed<Feed>(() => Promise.resolve(feed));

    await svc.invalidateListing(DISP_ID);

    const res = await svc.getDispensaryFeed<Feed>(() =>
      Promise.reject(new Error('loader should not run; expected cache hit')),
    );
    expect(res).toEqual(feed);
  });

  it('forces the next menu read for that dispensary to invoke the loader', async () => {
    const store = new CountingStore();
    const svc = new CatalogCacheService(store);
    const menu: Menu = { dispensaryId: DISP_ID, items: ['a'] };
    await svc.getDispensaryMenu<Menu>(DISP_ID, () => Promise.resolve(menu));

    await svc.invalidateListing(DISP_ID);

    const reloader = vi.fn().mockResolvedValue(menu);
    await svc.getDispensaryMenu<Menu>(DISP_ID, reloader);
    expect(reloader).toHaveBeenCalledTimes(1);
  });
});

describe('CatalogCacheService — cache key versioning', () => {
  it('prefixes feed keys with the current CACHE_VERSION namespace', async () => {
    const store = new CountingStore();
    const svc = new CatalogCacheService(store);

    await svc.getDispensaryFeed<Feed>(() => Promise.resolve({ dispensaries: [] }));

    // Even an empty array is a defined value — distinct from "no cache" — so
    // it is cached. (Only null/undefined are skipped.)
    expect(store.setCalls[0]?.key.startsWith(`${CACHE_VERSION}:`)).toBe(true);
  });

  it('prefixes menu keys with the current CACHE_VERSION namespace', async () => {
    const store = new CountingStore();
    const svc = new CatalogCacheService(store);

    await svc.getDispensaryMenu<Menu>(DISP_ID, () =>
      Promise.resolve({ dispensaryId: DISP_ID, items: [] }),
    );

    expect(store.setCalls[0]?.key.startsWith(`${CACHE_VERSION}:`)).toBe(true);
  });
});
