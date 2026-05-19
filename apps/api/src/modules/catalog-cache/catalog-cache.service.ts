/**
 * CatalogCacheService — read-through cache for the public catalog surfaces.
 *
 * Two cached surfaces, both keyed under a versioned namespace so a schema
 * change (e.g. adding a field to the menu projection) ships behind a
 * version bump and the previous keys age out naturally rather than
 * returning a stale shape to the client. Bumping `CACHE_VERSION` is the
 * intended way to roll out a breaking change to either projection.
 *
 *   v1:dispensary-feed                — the unfiltered active-dispensary
 *                                       list. Geo-filtered queries are
 *                                       not cached: lat/lng to 6 decimal
 *                                       places blows the key cardinality
 *                                       past anything useful, and the
 *                                       geo path is already bounded by a
 *                                       PostGIS index. Caller decides.
 *
 *   v1:dispensary-menu:<dispensaryId> — the per-dispensary menu (listings
 *                                       joined to products). One key per
 *                                       dispensary; bounded by the number
 *                                       of active stores in MN.
 *
 * Both keys live for 60 seconds (`CATALOG_CACHE_TTL_SECONDS`). The
 * dispensary-feed projection includes a `isOpenNow` flag computed from the
 * row's `hoursJson` at the moment the cache was populated — that flag is
 * therefore at most 60s stale at any read. This is acceptable: the
 * checkout path re-evaluates compliance authoritatively inside the
 * transaction that creates the order, so a 60s window where the discovery
 * surface advertises "open" past the actual close minute will fail at the
 * cart-validate / checkout step rather than landing a non-compliant
 * order. The trade is intentional — recomputing the projection on every
 * read would require either caching raw DB rows (extra deserialise cost
 * + Date revival ceremony) or invalidating the cache on every minute
 * boundary (defeats the cache).
 *
 * Invalidation is explicit and call-site visible — the admin services
 * (dispensary patch/activate/suspend) and the vendor listings service
 * (create/patch/delete) call `invalidateDispensary` / `invalidateListing`
 * after the DB write commits. No event bus, no implicit hooks: a reader
 * tracing "what blows this cache" follows the call graph from the cache
 * service, which is exactly the set of writers. Adding a future write
 * path that forgets to invalidate is the kind of bug code review catches
 * once the convention is established.
 *
 * Fail-open: every store call is best-effort. A Redis outage falls back
 * to the loader (which hits Postgres) — the read path stays available.
 * The service does NOT cache `null` from the loader: a transient failure
 * (or a 404) should not poison the cache for 60s.
 */
import { Inject, Injectable } from '@nestjs/common';
import { CATALOG_CACHE_STORE, type CatalogCacheStore } from './catalog-cache-store.js';

export const CACHE_VERSION = 'v1';
export const CATALOG_CACHE_TTL_SECONDS = 60;

const DISPENSARY_FEED_KEY = `${CACHE_VERSION}:dispensary-feed`;
const DISPENSARY_MENU_KEY_PREFIX = `${CACHE_VERSION}:dispensary-menu:`;

function dispensaryMenuKey(dispensaryId: string): string {
  return `${DISPENSARY_MENU_KEY_PREFIX}${dispensaryId}`;
}

@Injectable()
export class CatalogCacheService {
  constructor(@Inject(CATALOG_CACHE_STORE) private readonly store: CatalogCacheStore) {}

  /**
   * Read-through for the unfiltered dispensary feed. `loader` is invoked on
   * miss; its return value is cached for `CATALOG_CACHE_TTL_SECONDS`.
   * Loader errors propagate without poisoning the cache.
   */
  async getDispensaryFeed<T>(loader: () => Promise<T>): Promise<T> {
    return this.readThrough(DISPENSARY_FEED_KEY, loader);
  }

  /** Read-through for a single dispensary's menu. */
  async getDispensaryMenu<T>(dispensaryId: string, loader: () => Promise<T>): Promise<T> {
    return this.readThrough(dispensaryMenuKey(dispensaryId), loader);
  }

  /**
   * Drops the dispensary-feed cache and the named dispensary's menu cache.
   * Called from admin paths that mutate a dispensary row — both surfaces
   * may now project differently (status flips, hours edits, brand fields
   * the feed surfaces, etc.).
   */
  async invalidateDispensary(dispensaryId: string): Promise<void> {
    await this.store.del([DISPENSARY_FEED_KEY, dispensaryMenuKey(dispensaryId)]);
  }

  /**
   * Drops only the dispensary's menu cache. The feed projection does not
   * include listing-derived fields, so a listing edit cannot change the
   * feed shape — dropping the feed too would just churn the cache.
   */
  async invalidateListing(dispensaryId: string): Promise<void> {
    await this.store.del([dispensaryMenuKey(dispensaryId)]);
  }

  private async readThrough<T>(key: string, loader: () => Promise<T>): Promise<T> {
    // Store is typed `unknown` so the cast lives here, in the single typed
    // boundary between the catalog read path and the opaque JSON store.
    const hit = (await this.store.get(key)) as T | null;
    if (hit !== null) return hit;
    const fresh = await loader();
    // Cache the loader's result. Skip null/undefined: a transient miss or a
    // tombstone read should not lock the cache to that value for the TTL.
    // The `as unknown` lifts the unconstrained `T` to a type the loose `==`
    // comparison can evaluate honestly when T does include null/undefined.
    if ((fresh as unknown) != null) {
      await this.store.set(key, fresh, CATALOG_CACHE_TTL_SECONDS);
    }
    return fresh;
  }
}
