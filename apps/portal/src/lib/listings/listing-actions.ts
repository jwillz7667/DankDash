/**
 * Contract the menu table uses to talk to the vendor-listings surface.
 * Factored out as an interface so:
 *
 *   - Production wires the Next.js server actions in {@link import('./actions.js')}
 *     (which call `ApiClient` server-side, never leaking the access token).
 *   - Tests inject in-memory fakes — no Auth.js session, no Next runtime.
 *
 * Mirrors the `VendorOrderActions` pattern from Phase 14.
 */
import type {
  ListingImageUploadTicket,
  PatchVendorListingInput,
  SyncVendorListingsResult,
  UploadableListingImageType,
  VendorListing,
  VendorListingWithProduct,
} from '../api/vendor-listings.js';

export interface VendorListingActions {
  /** Replace the table snapshot. Called on refresh + after a sync. */
  readonly list: () => Promise<readonly VendorListingWithProduct[]>;
  /** PATCH a single listing. Used by inline-edit + override panel. */
  readonly patch: (listingId: string, patch: PatchVendorListingInput) => Promise<VendorListing>;
  /** Soft-delete a listing (flips `isActive` off). */
  readonly remove: (listingId: string) => Promise<void>;
  /** Trigger a manual POS sync. Returns the new lastSyncedAt + updated count. */
  readonly sync: () => Promise<SyncVendorListingsResult>;
  /**
   * Mint a presigned R2 POST for a single listing image. The override
   * panel uploads the file directly to storage with this ticket, then
   * persists the returned object key via {@link patch}. The minted key is
   * always under the caller dispensary's own prefix (server-scoped).
   */
  readonly requestImageUpload: (
    contentType: UploadableListingImageType,
  ) => Promise<ListingImageUploadTicket>;
}
