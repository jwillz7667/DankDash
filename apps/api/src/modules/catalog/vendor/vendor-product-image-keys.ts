/**
 * Where a dispensary's vendor-authored product images live in R2, and which
 * keys a vendor may bind to a product it owns.
 *
 * Mirrors the listing/brand image-key helpers: the upload minter produces keys
 * under {@link dispensaryProductImagePrefix} (the `products/` segment), and the
 * product write path validates that every imageKey the vendor sets is owned by
 * its own dispensary via {@link isProductImageKeyOwnedBy}. The ownership check
 * accepts any key under the tenant root (`dispensaries/<id>/`) — so a vendor
 * may reuse a listing/brand image on its product — while failing closed on a
 * cross-tenant key.
 *
 * The traversal guard rejects `..`/absolute/empty segments before the prefix
 * test, so `dispensaries/<self>/../<other>/x.jpg` (which a browser would
 * normalize to a foreign object) cannot pass.
 */
export function dispensaryProductImagePrefix(dispensaryId: string): string {
  return `dispensaries/${dispensaryId}/products/`;
}

export function dispensaryAssetRoot(dispensaryId: string): string {
  return `dispensaries/${dispensaryId}/`;
}

function isSafeRelativeKey(key: string): boolean {
  if (key === '' || key.startsWith('/')) return false;
  return key.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function isProductImageKeyOwnedBy(dispensaryId: string, key: string): boolean {
  return isSafeRelativeKey(key) && key.startsWith(dispensaryAssetRoot(dispensaryId));
}
