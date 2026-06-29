/**
 * Single source of truth for where a dispensary's brand assets (hero +
 * logo) live in R2, and which keys a vendor is allowed to bind to its own
 * storefront.
 *
 * Two callers must agree:
 *   - VendorSettingsUploadsService mints presigned-upload keys under
 *     {@link dispensaryBrandImagePrefix} (the `brand/` segment).
 *   - VendorSettingsService validates, on PATCH, that every brand image key
 *     a vendor sets is owned by *its own* dispensary via
 *     {@link isBrandImageKeyOwnedBy}.
 *
 * Why the ownership check is wider than the mint prefix: the validator
 * accepts any key under the dispensary's tenant root
 * (`dispensaries/<id>/`), not just `brand/`. That keeps it forgiving of
 * admin-provisioned keys (e.g. `dispensaries/<id>/hero.jpg`) and the
 * dispensary's own listing photos, while still failing closed on a
 * cross-tenant key (`dispensaries/<other>/…`). New vendor uploads always
 * land under `brand/`; the wider validator just never rejects a key the
 * tenant legitimately owns.
 *
 * The trailing slash is load-bearing: `startsWith` on a slash-terminated
 * prefix means `dispensaries/<a>/` cannot match a sibling tenant id that
 * merely shares a leading substring.
 */
export function dispensaryBrandImagePrefix(dispensaryId: string): string {
  return `dispensaries/${dispensaryId}/brand/`;
}

/** Tenant root under which every asset a dispensary owns is namespaced. */
export function dispensaryAssetRoot(dispensaryId: string): string {
  return `dispensaries/${dispensaryId}/`;
}

export function isBrandImageKeyOwnedBy(dispensaryId: string, key: string): boolean {
  return key.startsWith(dispensaryAssetRoot(dispensaryId));
}
