/**
 * Single source of truth for where a dispensary's listing images live in R2.
 *
 * Two callers must agree on this prefix:
 *   - VendorListingUploadsService mints presigned-upload keys under it.
 *   - VendorListingsService validates, on create/patch, that every imageKey
 *     a vendor sets sits under *its own* dispensary prefix.
 *
 * Keeping both on the same function closes a cross-tenant hole: without the
 * validation a vendor could PATCH its listing's `imageKeys` to point at
 * another dispensary's (or the admin catalog's) objects, and the public menu
 * would happily render them. A drift between mint and validate would instead
 * 422 legitimate uploads — so they read the same code, never two copies.
 *
 * The trailing slash is load-bearing: `startsWith` on a slash-terminated
 * prefix means `dispensaries/<a>/listings/` cannot match a sibling tenant id
 * that merely shares a leading substring.
 */
export function dispensaryListingImagePrefix(dispensaryId: string): string {
  return `dispensaries/${dispensaryId}/listings/`;
}

export function isImageKeyOwnedBy(dispensaryId: string, key: string): boolean {
  return key.startsWith(dispensaryListingImagePrefix(dispensaryId));
}
