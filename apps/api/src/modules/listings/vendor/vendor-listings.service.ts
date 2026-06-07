/**
 * Vendor write-side service for dispensary listings.
 *
 *   list()        — GET /v1/vendor/listings. Returns every listing the
 *                   dispensary owns, active or not. Inactive rows are
 *                   surfaced because the vendor portal reactivates from the
 *                   same list view; sorted updated-then-created descending
 *                   so recent edits land at the top.
 *
 *   create()      — POST /v1/vendor/listings. Pre-flights the productId
 *                   against the global catalog (a listing for a non-existent
 *                   product would fail at the FK with a generic 500; the
 *                   pre-flight returns a typed 422). Pre-flights
 *                   (dispensaryId, sku) uniqueness so a SKU collision lands
 *                   as 409 matching `dispensary_listings_disp_sku_uq`
 *                   instead of a raw DB error.
 *
 *   patch()       — PATCH /v1/vendor/listings/:id. Empty bodies rejected
 *                   here so the error message can be specific. Cross-checks
 *                   the compareAt/price invariant against the persisted row
 *                   when only one of the two is in the patch — the schema's
 *                   refine can only see what the patch carries. Cross-
 *                   dispensary writes match zero rows in
 *                   `updateForDispensary` and return 404.
 *
 *   delete()      — DELETE /v1/vendor/listings/:id. Flips `is_active` off
 *                   via `softDeleteForDispensary`. The schema cannot hard
 *                   delete because historical orders FK the row (`ON DELETE
 *                   RESTRICT`); the public menu joins on `isActive = true`
 *                   so deactivation is what the customer sees as removed.
 *                   Idempotent: deactivating a row that no longer matches
 *                   (either deleted or belongs to another dispensary) is
 *                   404 so the response cannot distinguish the two.
 *
 * Defense in depth: every operation runs inside a tx that sets
 * `app.current_dispensary_id` via `SET LOCAL` (through `set_config`). The
 * RLS policies on `dispensary_listings` activate when the connection runs
 * as `app_vendor` and read that GUC; in the current single-role deployment
 * the application-layer `WHERE dispensary_id = ?` filter in each repo
 * method is the primary guard and the GUC is a no-op, but the boilerplate
 * is here so a future Phase that swaps the vendor surface onto a separate
 * pooled connection picks it up without re-touching every service.
 *
 * `withScope` yields tx-bound repositories from an injected factory rather
 * than rebinding `this.listings`/`this.products`. Mutating fields on the
 * NestJS singleton would race under concurrent requests — two parallel
 * POSTs would each install their own scoped repo on the same service and
 * the second to enter `finally` would restore the *first* request's tx
 * repo as the "previous", leaking a closed tx across requests. The
 * factory shape also keeps the service unit-testable: the production
 * module passes the real repo constructors; tests pass closures over
 * in-memory fakes.
 */
import {
  sql,
  type DispensaryListingsRepository,
  type Database,
  type DispensaryListing,
  type NewDispensaryListing,
  type Product,
  type ProductsRepository,
} from '@dankdash/db';
import { ConflictError, NotFoundError, ValidationError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import { CatalogCacheService } from '../../catalog-cache/catalog-cache.service.js';
import { isImageKeyOwnedBy } from './listing-image-keys.js';
import type {
  CreateListingRequest,
  ListingListResponse,
  ListingResponse,
  ListingWithProductResponse,
  PatchListingRequest,
  SyncListingsResponse,
  VendorListingProductSummary,
} from './dto/index.js';
import type { VendorContext } from './vendor-context.types.js';

export interface ScopedRepos {
  readonly listings: DispensaryListingsRepository;
  readonly products: ProductsRepository;
}

export type ScopedReposFactory = (db: Database) => ScopedRepos;

@Injectable()
export class VendorListingsService {
  constructor(
    private readonly db: Database,
    private readonly reposFor: ScopedReposFactory,
    private readonly cache: CatalogCacheService,
  ) {}

  async list(ctx: VendorContext): Promise<ListingListResponse> {
    const rows = await this.withScope(ctx, ({ listings }) =>
      listings.listAllForDispensaryWithProducts(ctx.dispensaryId),
    );
    return {
      listings: rows.map(({ listing, product }) => projectListingWithProduct(listing, product)),
    };
  }

  async create(ctx: VendorContext, body: CreateListingRequest): Promise<ListingResponse> {
    const result = await this.withScope(ctx, async ({ listings, products }) => {
      const product = await products.findById(body.productId);
      if (product?.deletedAt !== null || !product.isActive) {
        throw new ValidationError(
          'productId references a product that does not exist or is not active',
          { productId: body.productId },
        );
      }
      const dup = await listings.findByDispensaryAndSku(ctx.dispensaryId, body.sku);
      if (dup !== null) {
        throw new ConflictError(
          'LISTING_SKU_TAKEN',
          'A listing with this SKU already exists for this dispensary',
          { dispensaryId: ctx.dispensaryId, sku: body.sku },
        );
      }
      if (body.imageKeys !== undefined) {
        this.assertImageKeysOwned(ctx.dispensaryId, body.imageKeys);
      }
      const row = await listings.create({
        dispensaryId: ctx.dispensaryId,
        productId: body.productId,
        sku: body.sku,
        priceCents: body.priceCents,
        compareAtPriceCents: body.compareAtPriceCents ?? null,
        ...(body.quantityAvailable !== undefined
          ? { quantityAvailable: body.quantityAvailable }
          : {}),
        ...(body.imageKeys !== undefined ? { imageKeys: body.imageKeys } : {}),
        metrcPackageTag: body.metrcPackageTag ?? null,
      });
      return projectListing(row);
    });
    // Invalidate after the tx commits — a write that rolls back leaves the
    // cache untouched, which is correct. The menu projection is the only
    // public surface a listing edit reaches; the feed key is unaffected.
    await this.cache.invalidateListing(ctx.dispensaryId);
    return result;
  }

  async patch(ctx: VendorContext, id: string, body: PatchListingRequest): Promise<ListingResponse> {
    if (Object.keys(body).length === 0) {
      throw new ValidationError('Patch body must include at least one field', { listingId: id });
    }
    const result = await this.withScope(ctx, async ({ listings }) => {
      const existing = await listings.findByIdForDispensary(id, ctx.dispensaryId);
      if (existing === null) {
        throw new NotFoundError('Listing', id);
      }
      // Cross-check compareAt/price invariant against persisted values when
      // only one side is in the patch — the schema's refine only sees the
      // patch carrier, so a partial that lifts the sale price above an
      // existing strike price would otherwise slip through.
      this.enforcePriceInvariants(existing, body);

      // Every image key must sit under this dispensary's own R2 prefix —
      // reject an attempt to point the listing at another tenant's objects
      // before it reaches the row.
      if (body.imageKeys !== undefined) {
        this.assertImageKeysOwned(ctx.dispensaryId, body.imageKeys);
      }

      // SKU rename also collides with the unique index; pre-flight so
      // the response is a typed 409 not a raw DB error.
      if (body.sku !== undefined && body.sku !== existing.sku) {
        const dup = await listings.findByDispensaryAndSku(ctx.dispensaryId, body.sku);
        if (dup !== null && dup.id !== id) {
          throw new ConflictError(
            'LISTING_SKU_TAKEN',
            'A listing with this SKU already exists for this dispensary',
            { dispensaryId: ctx.dispensaryId, sku: body.sku },
          );
        }
      }

      const patchInput: Partial<Omit<NewDispensaryListing, 'id' | 'createdAt' | 'dispensaryId'>> = {
        ...(body.sku !== undefined ? { sku: body.sku } : {}),
        ...(body.priceCents !== undefined ? { priceCents: body.priceCents } : {}),
        ...(body.compareAtPriceCents !== undefined
          ? { compareAtPriceCents: body.compareAtPriceCents }
          : {}),
        ...(body.quantityAvailable !== undefined
          ? { quantityAvailable: body.quantityAvailable }
          : {}),
        ...(body.imageKeys !== undefined ? { imageKeys: body.imageKeys } : {}),
        ...(body.metrcPackageTag !== undefined ? { metrcPackageTag: body.metrcPackageTag } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      };
      const updated = await listings.updateForDispensary(id, ctx.dispensaryId, patchInput);
      if (updated === null) {
        // Concurrent delete from another session between the find and the
        // update. Surface as NotFound so the vendor sees a consistent "the
        // row is gone" response rather than a 500.
        throw new NotFoundError('Listing', id);
      }
      return projectListing(updated);
    });
    await this.cache.invalidateListing(ctx.dispensaryId);
    return result;
  }

  async delete(ctx: VendorContext, id: string): Promise<void> {
    const ok = await this.withScope(ctx, ({ listings }) =>
      listings.softDeleteForDispensary(id, ctx.dispensaryId),
    );
    if (!ok) {
      // Missing row OR row belongs to another dispensary — same 404 either
      // way so a probing call cannot distinguish "did not exist" from
      // "belongs to another vendor".
      throw new NotFoundError('Listing', id);
    }
    await this.cache.invalidateListing(ctx.dispensaryId);
  }

  /**
   * Manual POS sync. Stamps `lastSyncedAt = now` on every active listing
   * the dispensary owns so the vendor portal's staleness banner clears
   * after a one-click gesture. The cache invalidation that follows is the
   * conservative move — a listing's projected payload includes
   * `lastSyncedAt`, and a sync that doesn't flush the public-facing
   * projections would leave the menu reading the pre-sync timestamp until
   * the next write.
   *
   * Returns the count of rows updated and the canonical timestamp. The
   * controller serializes the Date to ISO-with-offset to match
   * `SyncListingsResponseSchema`.
   *
   * Async POS reconciliation (Treez / Dutchie listing diff, Metrc package
   * pull) replaces this internal implementation in a follow-up phase
   * without changing the wire contract — the vendor portal already knows
   * to await this Promise before re-listing.
   */
  async sync(ctx: VendorContext): Promise<SyncListingsResponse> {
    const result = await this.withScope(ctx, ({ listings }) =>
      listings.stampActiveSyncedForDispensary(ctx.dispensaryId),
    );
    await this.cache.invalidateListing(ctx.dispensaryId);
    return {
      updated: result.updated,
      syncedAt: result.syncedAt.toISOString(),
    };
  }

  /**
   * Runs `fn` inside a tx that sets `app.current_dispensary_id` so the RLS
   * policies on `dispensary_listings` (defined `FOR ALL TO app_vendor` in
   * migration 0000_init.sql) read it through `current_setting`. In the
   * current single-role deployment this is a no-op at the policy layer;
   * the application-level WHERE clauses are the primary guard. Wrapped
   * here so a future Phase that swaps the vendor surface onto a dedicated
   * `app_vendor` connection pool activates RLS without a service edit.
   *
   * `set_config(name, value, is_local=true)` is parameter-safe; constructing
   * `SET LOCAL app.current_dispensary_id = ?` via string interpolation would
   * be unsafe even though the upstream guard already constrained the value
   * to a UUID shape.
   */
  private withScope<T>(ctx: VendorContext, fn: (deps: ScopedRepos) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.current_dispensary_id', ${ctx.dispensaryId}, true)`,
      );
      // Drizzle's tx is structurally a PgDatabase for every method these
      // repos call, but the postgres-js Database type carries an extra
      // `$client` field the tx does not — the cast inside the factory is a
      // type-system accommodation, not a runtime concern.
      return fn(this.reposFor(tx));
    });
  }

  /**
   * Defends the cross-tenant boundary on image keys. The DTO already capped
   * the count and string length; here we reject any key that does not sit
   * under this dispensary's own R2 prefix, so a vendor cannot bind its public
   * listing to another tenant's (or the admin catalog's) uploaded objects.
   * The presign endpoint only ever mints keys under this prefix, so a
   * legitimate round-trip always passes.
   */
  private assertImageKeysOwned(dispensaryId: string, keys: readonly string[]): void {
    const foreign = keys.filter((key) => !isImageKeyOwnedBy(dispensaryId, key));
    if (foreign.length > 0) {
      throw new ValidationError('imageKeys must reference objects uploaded under this dispensary', {
        dispensaryId,
        foreign,
      });
    }
  }

  private enforcePriceInvariants(existing: DispensaryListing, patch: PatchListingRequest): void {
    const nextPrice = patch.priceCents ?? existing.priceCents;
    const nextCompareRaw =
      patch.compareAtPriceCents === undefined
        ? existing.compareAtPriceCents
        : patch.compareAtPriceCents;
    if (nextCompareRaw === null) return;
    if (nextCompareRaw <= nextPrice) {
      throw new ValidationError('compareAtPriceCents must be strictly greater than priceCents', {
        listingId: existing.id,
        priceCents: nextPrice,
        compareAtPriceCents: nextCompareRaw,
      });
    }
  }
}

function projectListing(row: DispensaryListing): ListingResponse {
  return {
    id: row.id,
    dispensaryId: row.dispensaryId,
    productId: row.productId,
    sku: row.sku,
    priceCents: row.priceCents,
    compareAtPriceCents: row.compareAtPriceCents,
    quantityAvailable: row.quantityAvailable,
    imageKeys: row.imageKeys,
    metrcPackageTag: row.metrcPackageTag,
    lastSyncedAt: row.lastSyncedAt === null ? null : row.lastSyncedAt.toISOString(),
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function projectProductSummary(product: Product): VendorListingProductSummary {
  return {
    id: product.id,
    brand: product.brand,
    name: product.name,
    productType: product.productType,
    strainType: product.strainType,
    thcMgPerUnit: product.thcMgPerUnit,
    weightGramsPerUnit: product.weightGramsPerUnit,
    imageKeys: product.imageKeys,
    isActive: product.isActive,
    deletedAt: product.deletedAt === null ? null : product.deletedAt.toISOString(),
  };
}

function projectListingWithProduct(
  listing: DispensaryListing,
  product: Product,
): ListingWithProductResponse {
  return { ...projectListing(listing), product: projectProductSummary(product) };
}
