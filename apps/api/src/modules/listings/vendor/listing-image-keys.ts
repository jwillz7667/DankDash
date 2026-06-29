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

/**
 * Reject empty, absolute, or traversal-bearing keys before the prefix test.
 * A bare `startsWith` is not enough: `dispensaries/<self>/listings/../../<other>/x.jpg`
 * starts with the prefix yet a browser normalizes the `..` and fetches a
 * foreign tenant's object. Requiring every segment to be non-empty and not
 * `.`/`..` makes the prefix check authoritative.
 */
function isSafeRelativeKey(key: string): boolean {
  if (key === '' || key.startsWith('/')) return false;
  return key.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function isImageKeyOwnedBy(dispensaryId: string, key: string): boolean {
  return isSafeRelativeKey(key) && key.startsWith(dispensaryListingImagePrefix(dispensaryId));
}
