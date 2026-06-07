'use client';

/**
 * Right-side slide-in panel for the "richer" per-listing edit the menu
 * table's inline cells don't cover:
 *
 *   - **Images** — upload a photo (presign → direct R2 POST → persist the
 *     returned key on `imageKeys`) and remove existing ones. When a listing
 *     has any override images, the consumer menu renders these instead of
 *     the shared product catalog photos; clearing them all falls back to the
 *     product photos. The upload bytes go straight to R2 from the browser —
 *     they never traverse the portal's Node runtime.
 *   - **Details** — SKU, compare-at price, and Metrc package tag, each
 *     committed through the same `PATCH /v1/vendor/listings/:id` the inline
 *     cells use. The server re-runs the `compareAt > price` invariant, so an
 *     invalid strike-through surfaces as a typed 422 here.
 *
 * Mirrors the `OrderDetailDrawer` overlay structure (backdrop button +
 * `role="dialog"` + ESC dismiss) so the two slide-overs feel identical.
 * Snapshot ownership stays in the parent: every successful patch returns the
 * merged listing via `onPatch`, and the panel reflects it locally so the
 * gallery + drafts stay live without a refetch.
 */
import { ImagePlus, Loader2, Save, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import {
  isUploadableListingImageType,
  uploadListingImageToStorage,
  type ListingImageUploadTicket,
  type PatchVendorListingInput,
  type UploadableListingImageType,
  type VendorListingWithProduct,
} from '../../lib/api/vendor-listings.js';
import { cn } from '../../lib/cn.js';
import { formatCentsForInput, parseInputToCents } from '../../lib/listings/format.js';
import { listingImageUrl } from '../../lib/listings/images.js';
import { formatMoney } from '../../lib/orders/format.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';

/** Server caps a listing at 10 override images; mirror it client-side. */
const MAX_IMAGES = 10;

const ACCEPT_ATTR = 'image/jpeg,image/png,image/webp';

export interface ListingOverridePanelProps {
  /** The listing to edit, or `null` to keep the panel unmounted. */
  readonly listing: VendorListingWithProduct | null;
  readonly onClose: () => void;
  /** Patch the listing on the server; returns the merged row for the snapshot. */
  readonly onPatch: (
    listingId: string,
    patch: PatchVendorListingInput,
  ) => Promise<VendorListingWithProduct>;
  /** Mint a presigned R2 upload ticket for the given content type. */
  readonly requestImageUpload: (
    contentType: UploadableListingImageType,
  ) => Promise<ListingImageUploadTicket>;
  /** Public R2 base for image previews; undefined renders a key placeholder. */
  readonly imageBaseUrl?: string;
  /** Test seam — the direct-to-storage uploader (defaults to the real one). */
  readonly uploadToStorage?: typeof uploadListingImageToStorage;
}

export function ListingOverridePanel({
  listing,
  onClose,
  onPatch,
  requestImageUpload,
  imageBaseUrl,
  uploadToStorage,
}: ListingOverridePanelProps): ReactNode {
  const [working, setWorking] = useState<VendorListingWithProduct | null>(listing);
  const [sku, setSku] = useState('');
  const [compareAtInput, setCompareAtInput] = useState('');
  const [metrcInput, setMetrcInput] = useState('');
  const [uploading, setUploading] = useState(false);
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [savingDetails, setSavingDetails] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Reseed local state whenever the parent opens a different listing.
  useEffect(() => {
    setWorking(listing);
    if (listing !== null) {
      setSku(listing.sku);
      setCompareAtInput(
        listing.compareAtPriceCents === null
          ? ''
          : formatCentsForInput(listing.compareAtPriceCents),
      );
      setMetrcInput(listing.metrcPackageTag ?? '');
    }
    setImageError(null);
    setDetailError(null);
    setUploading(false);
    setRemovingKey(null);
    setSavingDetails(false);
  }, [listing]);

  useEffect(() => {
    if (listing === null) return;
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('keydown', handleKey);
    };
  }, [listing, onClose]);

  const handleFileSelected = useCallback(
    async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
      const file = event.target.files?.[0];
      // Reset the input so re-selecting the same file fires `change` again.
      event.target.value = '';
      if (file === undefined || working === null) return;
      if (!isUploadableListingImageType(file.type)) {
        setImageError('Use a JPEG, PNG, or WebP image.');
        return;
      }
      if (working.imageKeys.length >= MAX_IMAGES) {
        setImageError(`A listing can have at most ${MAX_IMAGES} images.`);
        return;
      }
      setUploading(true);
      setImageError(null);
      try {
        const ticket = await requestImageUpload(file.type);
        const upload = uploadToStorage ?? uploadListingImageToStorage;
        const key = await upload(ticket, file);
        const merged = await onPatch(working.id, { imageKeys: [...working.imageKeys, key] });
        setWorking(merged);
      } catch (error) {
        setImageError(extractMessage(error, "Couldn't upload that image. Try again."));
      } finally {
        setUploading(false);
      }
    },
    [onPatch, requestImageUpload, uploadToStorage, working],
  );

  const handleRemoveImage = useCallback(
    async (key: string): Promise<void> => {
      if (working === null) return;
      setRemovingKey(key);
      setImageError(null);
      try {
        const next = working.imageKeys.filter((k) => k !== key);
        const merged = await onPatch(working.id, { imageKeys: next });
        setWorking(merged);
      } catch (error) {
        setImageError(extractMessage(error, "Couldn't remove that image. Try again."));
      } finally {
        setRemovingKey(null);
      }
    },
    [onPatch, working],
  );

  const handleSaveDetails = useCallback(async (): Promise<void> => {
    if (working === null) return;
    // Mutable accumulator — only changed fields go on the wire. Structurally
    // assignable to the readonly `PatchVendorListingInput` at the call site.
    const patch: {
      sku?: string;
      compareAtPriceCents?: number | null;
      metrcPackageTag?: string | null;
    } = {};

    const trimmedSku = sku.trim();
    if (trimmedSku !== working.sku) {
      if (trimmedSku === '') {
        setDetailError('SKU is required.');
        return;
      }
      patch.sku = trimmedSku;
    }

    const compareAt = parseCompareAtInput(compareAtInput);
    if (compareAt === 'invalid') {
      setDetailError('Compare-at must be a positive amount, or blank to clear it.');
      return;
    }
    if (compareAt !== working.compareAtPriceCents) {
      patch.compareAtPriceCents = compareAt;
    }

    const trimmedMetrc = metrcInput.trim();
    const metrc = trimmedMetrc === '' ? null : trimmedMetrc;
    if (metrc !== working.metrcPackageTag) {
      patch.metrcPackageTag = metrc;
    }

    if (Object.keys(patch).length === 0) {
      // Nothing changed — treat "Save" as a no-op close, matching the
      // server which would reject an empty patch with a 422.
      onClose();
      return;
    }

    setSavingDetails(true);
    setDetailError(null);
    try {
      const merged = await onPatch(working.id, patch);
      setWorking(merged);
      setSku(merged.sku);
      setCompareAtInput(
        merged.compareAtPriceCents === null ? '' : formatCentsForInput(merged.compareAtPriceCents),
      );
      setMetrcInput(merged.metrcPackageTag ?? '');
    } catch (error) {
      setDetailError(
        extractMessage(error, "Couldn't save those details. Check the values and retry."),
      );
    } finally {
      setSavingDetails(false);
    }
  }, [compareAtInput, metrcInput, onClose, onPatch, sku, working]);

  if (working === null) return null;

  const busy = uploading || removingKey !== null || savingDetails;
  const atImageLimit = working.imageKeys.length >= MAX_IMAGES;

  return (
    <div className="fixed inset-0 z-40" data-testid="listing-override-root">
      <button
        type="button"
        className="absolute inset-0 bg-surface-inverse/40 backdrop-blur-sm"
        aria-label="Close listing editor"
        onClick={onClose}
        data-testid="listing-override-backdrop"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="listing-override-title"
        data-testid="listing-override-panel"
        className={cn(
          'absolute right-0 top-0 flex h-full w-full max-w-md flex-col',
          'border-l border-outline bg-surface shadow-2xl',
        )}
      >
        <header className="flex items-start justify-between gap-3 border-b border-outline px-6 py-4">
          <div className="min-w-0 space-y-1">
            <h2
              id="listing-override-title"
              className="truncate text-lg font-semibold tracking-tight text-foreground"
            >
              {working.product.brand} — {working.product.name}
            </h2>
            <p className="truncate text-xs text-muted">{working.sku}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mt-1 flex h-9 w-9 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-subtle hover:text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss-500"
            data-testid="listing-override-close"
          >
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 space-y-7 overflow-y-auto px-6 py-5">
          <section aria-label="Listing images" className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-2xs font-semibold uppercase tracking-wider text-muted">Images</h3>
              <Badge tone={working.imageKeys.length > 0 ? 'success' : 'neutral'}>
                {working.imageKeys.length > 0
                  ? `${working.imageKeys.length} custom`
                  : 'Using product photos'}
              </Badge>
            </div>
            <p className="text-xs text-muted">
              Photos shown to shoppers for this listing. With none set, the menu falls back to the
              catalog product photos.
            </p>

            {working.imageKeys.length > 0 ? (
              <ul className="grid grid-cols-3 gap-3" data-testid="listing-override-gallery">
                {working.imageKeys.map((key) => (
                  <li
                    key={key}
                    className="group relative aspect-square overflow-hidden rounded-xl border border-outline bg-surface-subtle"
                  >
                    <ImageTile imageKey={key} baseUrl={imageBaseUrl} />
                    <button
                      type="button"
                      onClick={() => {
                        void handleRemoveImage(key);
                      }}
                      disabled={busy}
                      aria-label={`Remove image ${key}`}
                      className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-surface-inverse/70 text-on-primary shadow-sm transition-opacity hover:bg-surface-inverse focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss-500 disabled:opacity-50"
                    >
                      {removingKey === key ? (
                        <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 aria-hidden="true" className="h-4 w-4" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT_ATTR}
              className="sr-only"
              data-testid="listing-override-file-input"
              onChange={(e) => {
                void handleFileSelected(e);
              }}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy || atImageLimit}
              onClick={() => {
                fileInputRef.current?.click();
              }}
              data-testid="listing-override-upload"
            >
              {uploading ? (
                <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              ) : (
                <ImagePlus aria-hidden="true" className="h-4 w-4" />
              )}
              {uploading ? 'Uploading…' : 'Upload image'}
            </Button>
            {atImageLimit ? (
              <p className="text-xs text-muted">Image limit reached ({MAX_IMAGES}).</p>
            ) : null}
            {imageError !== null ? (
              <p
                role="alert"
                className="text-xs text-danger"
                data-testid="listing-override-image-error"
              >
                {imageError}
              </p>
            ) : null}
          </section>

          <section aria-label="Listing details" className="space-y-4">
            <h3 className="text-2xs font-semibold uppercase tracking-wider text-muted">Details</h3>

            <div className="space-y-1.5">
              <Label htmlFor="listing-override-sku">SKU</Label>
              <Input
                id="listing-override-sku"
                value={sku}
                onChange={(e) => {
                  setSku(e.target.value);
                }}
                disabled={savingDetails}
                autoComplete="off"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="listing-override-compare-at">Compare-at price</Label>
              <div className="relative">
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted"
                >
                  $
                </span>
                <Input
                  id="listing-override-compare-at"
                  value={compareAtInput}
                  onChange={(e) => {
                    setCompareAtInput(e.target.value);
                  }}
                  inputMode="decimal"
                  placeholder="Blank to clear"
                  disabled={savingDetails}
                  className="pl-6"
                />
              </div>
              <p className="text-xs text-muted">
                Strike-through reference price. Must exceed the live price (
                {formatMoney(working.priceCents)}).
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="listing-override-metrc">Metrc package tag</Label>
              <Input
                id="listing-override-metrc"
                value={metrcInput}
                onChange={(e) => {
                  setMetrcInput(e.target.value);
                }}
                placeholder="Blank to clear"
                disabled={savingDetails}
                autoComplete="off"
                className="font-mono"
              />
            </div>

            {detailError !== null ? (
              <p
                role="alert"
                className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger"
                data-testid="listing-override-detail-error"
              >
                {detailError}
              </p>
            ) : null}
          </section>
        </div>

        <footer className="flex justify-end gap-2 border-t border-outline bg-surface-muted/40 px-6 py-4">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              void handleSaveDetails();
            }}
            disabled={busy}
            data-testid="listing-override-save"
          >
            <Save aria-hidden="true" className="h-4 w-4" />
            {savingDetails ? 'Saving…' : 'Save details'}
          </Button>
        </footer>
      </div>
    </div>
  );
}

function ImageTile({
  imageKey,
  baseUrl,
}: {
  readonly imageKey: string;
  readonly baseUrl: string | undefined;
}): ReactNode {
  const url = listingImageUrl(imageKey, baseUrl);
  if (url === null) {
    // No CDN base configured — show the trailing key segment so the
    // operator can still tell the images apart before the bucket is public.
    const label = imageKey.split('/').pop() ?? imageKey;
    return (
      <div className="flex h-full w-full items-center justify-center p-2 text-center text-2xs text-muted">
        <span className="break-all">{label}</span>
      </div>
    );
  }
  return <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" />;
}

/**
 * Parse the compare-at input. Empty → `null` (clear the strike-through);
 * a valid positive amount → cents; anything else → `'invalid'` so the
 * caller can surface a typed message instead of silently dropping it.
 */
function parseCompareAtInput(raw: string): number | null | 'invalid' {
  if (raw.trim() === '') return null;
  const cents = parseInputToCents(raw);
  if (cents === null || cents <= 0) return 'invalid';
  return cents;
}

function extractMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return fallback;
}
