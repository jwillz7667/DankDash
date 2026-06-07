'use server';

/**
 * Next.js server actions for the vendor-listings surface. Each action
 * builds a request-scoped `ApiClient` from the Auth.js session and
 * proxies to the typed call in `lib/api/vendor-listings.ts`. The menu
 * table (and the override panel) call these from the browser via the
 * `VendorListingActions` interface — the access token never leaves the
 * server runtime.
 *
 * Same rationale as `lib/orders/actions.ts`: server actions get full
 * Auth.js refresh semantics for free, and `buildServerApiClient` enforces
 * the "no-dispensary-context → typed error" guard so a stray click
 * during an unsupported state surfaces as a typed error, not a 500.
 *
 * NOTE: Next.js 15 server-action files restrict top-level exports to
 * async functions. Helpers and error types live in `actions-errors.ts`.
 */
import { buildServerApiClient } from '../api/server-client.js';
import {
  deleteVendorListing,
  listVendorListings,
  patchVendorListing,
  requestListingImageUpload,
  triggerVendorListingsSync,
  type ListingImageUploadTicket,
  type PatchVendorListingInput,
  type SyncVendorListingsResult,
  type UploadableListingImageType,
  type VendorListing,
  type VendorListingWithProduct,
} from '../api/vendor-listings.js';
import { NoDispensaryContextError } from './actions-errors.js';
import type { ApiClient } from '../api/client.js';

async function authedClient(): Promise<ApiClient> {
  const ctx = await buildServerApiClient();
  if (ctx?.dispensary == null) {
    throw new NoDispensaryContextError();
  }
  return ctx.client;
}

export async function listVendorListingsAction(): Promise<readonly VendorListingWithProduct[]> {
  const result = await listVendorListings(await authedClient());
  return result.listings;
}

export async function patchVendorListingAction(
  listingId: string,
  patch: PatchVendorListingInput,
): Promise<VendorListing> {
  return patchVendorListing(await authedClient(), listingId, patch);
}

export async function deleteVendorListingAction(listingId: string): Promise<void> {
  return deleteVendorListing(await authedClient(), listingId);
}

export async function triggerVendorListingsSyncAction(): Promise<SyncVendorListingsResult> {
  return triggerVendorListingsSync(await authedClient());
}

export async function requestListingImageUploadAction(
  contentType: UploadableListingImageType,
): Promise<ListingImageUploadTicket> {
  return requestListingImageUpload(await authedClient(), contentType);
}
