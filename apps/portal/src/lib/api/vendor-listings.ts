/**
 * Typed surface for the vendor-listings endpoints the portal menu page
 * consumes.
 *
 * Mirrors the wire shape from
 * `apps/api/src/modules/listings/vendor/dto/`:
 *
 *   - `ListingResponseSchema`           → {@link VendorListing}
 *   - `ListingListResponseSchema`       → return of {@link listVendorListings}
 *   - `PatchListingRequestSchema`       → {@link PatchVendorListingInput}
 *   - `SyncListingsResponseSchema`      → return of {@link triggerVendorListingsSync}
 *
 * Hand-mirrored rather than imported to keep NestJS metadata out of the
 * Next bundle (same rationale as `vendor-orders.ts`). A drift between
 * this and the API DTO surfaces as a typecheck failure on the consumer
 * that reads a field that no longer exists.
 */
import type { ApiClient } from './client.js';
import type { ImageUploadTicket, UploadableImageType } from './image-uploads.js';

export interface VendorListing {
  readonly id: string;
  readonly dispensaryId: string;
  readonly productId: string;
  readonly sku: string;
  readonly priceCents: number;
  readonly compareAtPriceCents: number | null;
  readonly quantityAvailable: number;
  /**
   * Per-listing image override keys (R2 object keys under this dispensary's
   * prefix). When non-empty, the consumer menu renders these instead of the
   * shared product images; empty means "fall back to the product photos".
   */
  readonly imageKeys: readonly string[];
  readonly metrcPackageTag: string | null;
  readonly lastSyncedAt: string | null;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Compact product fields embedded on every row in
 * {@link listVendorListings}. The menu page needs brand/name/type/imageKeys
 * to render the table; doing it via a separate N+1 catalog fetch would be
 * slow and force the portal to handle two failure paths instead of one.
 *
 * `isActive` and `deletedAt` surface the product's global state so the
 * vendor row can flag rows where the product was pulled from the catalog
 * (and the public menu has stopped showing it).
 */
export interface VendorListingProductSummary {
  readonly id: string;
  readonly brand: string;
  readonly name: string;
  readonly productType: string;
  readonly strainType: string | null;
  readonly thcMgPerUnit: string;
  readonly weightGramsPerUnit: string;
  readonly imageKeys: readonly string[];
  readonly isActive: boolean;
  readonly deletedAt: string | null;
}

export interface VendorListingWithProduct extends VendorListing {
  readonly product: VendorListingProductSummary;
}

export interface ListVendorListingsResult {
  readonly listings: readonly VendorListingWithProduct[];
}

/**
 * Patch shape accepted by {@link patchVendorListing}. Every field is
 * optional and the server rejects an empty patch with a 422. The patch
 * also re-runs the `compareAtPriceCents > priceCents` invariant against
 * the persisted row, so a partial that lifts price above an existing
 * strike-through is rejected even if the patch only carries `priceCents`.
 *
 * `productId` is intentionally absent — changing the product a listing
 * binds to is a different operation (delete + re-create); the API
 * rejects it.
 */
export interface PatchVendorListingInput {
  readonly sku?: string;
  readonly priceCents?: number;
  readonly compareAtPriceCents?: number | null;
  readonly quantityAvailable?: number;
  /**
   * Replace the listing's image-override set. The server re-validates that
   * every key sits under this dispensary's own R2 prefix (a forged key for
   * another store's prefix is a 422), so the portal can only ever attach
   * images it uploaded. An empty array clears every override and the
   * consumer menu falls back to the shared product photos.
   */
  readonly imageKeys?: readonly string[];
  readonly metrcPackageTag?: string | null;
  readonly isActive?: boolean;
}

export interface SyncVendorListingsResult {
  /** Count of listings updated by the sync run. */
  readonly updated: number;
  /** ISO timestamp the sync completed at. */
  readonly syncedAt: string;
}

/**
 * GET /v1/vendor/listings — every listing the dispensary owns, active
 * and inactive. Sorted by `updatedAt DESC, createdAt DESC` so a recent
 * edit (price flip, qty bump) lands at the top of the table.
 */
export async function listVendorListings(client: ApiClient): Promise<ListVendorListingsResult> {
  return client.request<ListVendorListingsResult>('/v1/vendor/listings');
}

/**
 * PATCH /v1/vendor/listings/:id — partial update. The portal table uses
 * this for the three inline edits (price, qty, isActive); the override
 * panel uses it for the full field set.
 */
export async function patchVendorListing(
  client: ApiClient,
  listingId: string,
  patch: PatchVendorListingInput,
): Promise<VendorListing> {
  return client.request<VendorListing>(`/v1/vendor/listings/${encodeURIComponent(listingId)}`, {
    method: 'PATCH',
    body: patch,
  });
}

/**
 * DELETE /v1/vendor/listings/:id — soft delete (flips `isActive` off).
 * 204 No Content on success. Re-activating an inactive listing happens
 * via PATCH `{ isActive: true }`, not a re-create, because the
 * dispensary/SKU pair must remain unique.
 */
export async function deleteVendorListing(client: ApiClient, listingId: string): Promise<void> {
  await client.request<unknown>(`/v1/vendor/listings/${encodeURIComponent(listingId)}`, {
    method: 'DELETE',
  });
}

/**
 * POST /v1/vendor/listings/sync — manually trigger a POS sync. The API
 * stamps `lastSyncedAt` on every active listing for the dispensary and
 * returns the count. Async POS reconciliation (Metrc inventory pull,
 * Treez/Dutchie listing diff) lands in a follow-up phase; today this
 * gives the portal an idempotent "I know what I'm looking at" affordance.
 */
export async function triggerVendorListingsSync(
  client: ApiClient,
): Promise<SyncVendorListingsResult> {
  return client.request<SyncVendorListingsResult>('/v1/vendor/listings/sync', {
    method: 'POST',
  });
}

/**
 * Listing image uploads reuse the shared presign → direct-to-R2 → persist
 * primitives in `image-uploads.ts` (the brand uploader shares the same set).
 * These aliases preserve the listing-named surface the menu table + override
 * panel already import, so the shared module stays an implementation detail.
 */
export {
  UPLOADABLE_IMAGE_TYPES as UPLOADABLE_LISTING_IMAGE_TYPES,
  isUploadableImageType as isUploadableListingImageType,
  uploadImageToStorage as uploadListingImageToStorage,
  ImageUploadError as ListingImageUploadError,
} from './image-uploads.js';
export type {
  UploadableImageType as UploadableListingImageType,
  ImageUploadTicket as ListingImageUploadTicket,
} from './image-uploads.js';

/**
 * POST /v1/vendor/listings/image-uploads — mint a presigned R2 upload for a
 * single listing image. The dispensary scope comes from the client's
 * `X-Dispensary-Id` header, so the minted key is always under the caller's
 * own prefix.
 */
export async function requestListingImageUpload(
  client: ApiClient,
  contentType: UploadableImageType,
): Promise<ImageUploadTicket> {
  return client.request<ImageUploadTicket>('/v1/vendor/listings/image-uploads', {
    method: 'POST',
    body: { contentType },
  });
}
