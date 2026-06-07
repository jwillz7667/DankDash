/**
 * Compose a public image URL from an R2 object key.
 *
 * Listings and products carry bare R2 object keys on the wire (e.g.
 * `dispensaries/<id>/listings/<uuid>.jpg`); the bucket is served via an
 * optional public base (`NEXT_PUBLIC_R2_PUBLIC_BASE_URL`). This mirrors
 * the server-side `R2Storage.getPublicUrl` semantics — `${base}/${key}`
 * with the base's trailing slashes stripped — so the portal renders the
 * same URL the consumer app does.
 *
 * Returns `null` when no base is configured (the CDN isn't provisioned
 * yet) so callers render a placeholder rather than a broken `<img>`.
 */
export function listingImageUrl(key: string, base: string | undefined): string | null {
  if (base === undefined || base === '') return null;
  const trimmedBase = base.replace(/\/+$/u, '');
  const trimmedKey = key.replace(/^\/+/u, '');
  if (trimmedKey === '') return null;
  return `${trimmedBase}/${trimmedKey}`;
}
