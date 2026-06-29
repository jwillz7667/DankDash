'use client';

/**
 * Brand card: storefront hero + logo images and the brand accent color.
 *
 * Images use the presign → direct-to-R2 → persist flow (shared with the
 * menu's listing uploader): the browser asks the API for a presigned POST,
 * uploads the file straight to object storage, then PATCHes the returned
 * object key onto `heroImageKey` / `logoImageKey`. The bytes never traverse
 * the portal's Node runtime, and the server re-validates that the key sits
 * under this dispensary's own prefix before persisting — a forged key for
 * another store is a typed 422.
 *
 * Each image commits on upload/remove (no separate "save"), matching the
 * listing override panel; the parent owns the `VendorSettings` snapshot and
 * re-renders the field with the new key. The accent color is the one field
 * that still saves explicitly, since it's free text the operator types.
 */
import { ImagePlus, Loader2, Palette, Trash2 } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { isUploadableImageType, uploadImageToStorage } from '../../lib/api/image-uploads.js';
import { listingImageUrl } from '../../lib/listings/images.js';
import { Button } from '../ui/button.js';
import { Card, CardBody, CardHeader, CardSubtitle, CardTitle } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import type { VendorSettings } from '../../lib/api/vendor-settings.js';
import type { VendorSettingsActions } from '../../lib/settings/settings-actions.js';

/** Mirror the server's 5 MiB presigned-policy ceiling so we fail fast with a clear message. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const ACCEPT_ATTR = 'image/jpeg,image/png,image/webp';

export interface BrandCardProps {
  readonly brandColorHex: string | null;
  readonly logoImageKey: string | null;
  readonly heroImageKey: string | null;
  readonly onPatch: VendorSettingsActions['patch'];
  readonly onPatched: (settings: VendorSettings) => void;
  readonly requestImageUpload: VendorSettingsActions['requestImageUpload'];
  /** Public R2 base for previews; undefined renders a key placeholder. */
  readonly imageBaseUrl?: string;
  /** Test seam — the direct-to-storage uploader (defaults to the real one). */
  readonly uploadToStorage?: typeof uploadImageToStorage;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/u;

export function BrandCard({
  brandColorHex,
  logoImageKey,
  heroImageKey,
  onPatch,
  onPatched,
  requestImageUpload,
  imageBaseUrl,
  uploadToStorage,
}: BrandCardProps): ReactNode {
  const [color, setColor] = useState(brandColorHex ?? '');
  const [savingColor, setSavingColor] = useState(false);
  const [colorError, setColorError] = useState<string | null>(null);
  const [colorSaved, setColorSaved] = useState(false);
  const colorId = useId();

  // One gate across the whole card: the hero upload, the logo upload, and the
  // color save each return the *full* settings row, so letting two run at once
  // would let the second response clobber the first's field in the snapshot.
  // Serializing them (matching the listing override panel's single `busy`)
  // keeps the optimistic snapshot consistent without a refetch.
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setColor(brandColorHex ?? '');
  }, [brandColorHex]);

  const swatchValid = HEX_RE.test(color);
  const colorNorm = color.trim() === '' ? null : color.trim();
  const colorDirty = colorNorm !== brandColorHex;

  const handleColorSubmit = useCallback(
    async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      setColorError(null);
      setColorSaved(false);
      if (colorNorm !== null && !HEX_RE.test(colorNorm)) {
        setColorError('Brand color must be #RRGGBB.');
        return;
      }
      setSavingColor(true);
      setBusy(true);
      try {
        const updated = await onPatch({ brandColorHex: colorNorm });
        onPatched(updated);
        setColorSaved(true);
      } catch (err) {
        setColorError(extractError(err, "Couldn't save the color. Try again."));
      } finally {
        setSavingColor(false);
        setBusy(false);
      }
    },
    [colorNorm, onPatch, onPatched],
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-moss-50 text-moss-700">
            <Palette aria-hidden="true" className="h-4 w-4" />
          </div>
          <div>
            <CardTitle>Brand</CardTitle>
            <CardSubtitle>The images and color the consumer app uses for your storefront.</CardSubtitle>
          </div>
        </div>
      </CardHeader>
      <CardBody className="space-y-7">
        <BrandImageField
          field="heroImageKey"
          label="Storefront hero"
          description="The wide banner shown at the top of your store page. Landscape (16:9) looks best."
          imageKey={heroImageKey}
          aspectClass="aspect-[16/9]"
          onPatch={onPatch}
          onPatched={onPatched}
          requestImageUpload={requestImageUpload}
          imageBaseUrl={imageBaseUrl}
          uploadToStorage={uploadToStorage}
          cardBusy={busy}
          onBusyChange={setBusy}
        />

        <BrandImageField
          field="logoImageKey"
          label="Logo"
          description="Your mark, shown next to your store name. A square image works best."
          imageKey={logoImageKey}
          aspectClass="aspect-square max-w-[10rem]"
          onPatch={onPatch}
          onPatched={onPatched}
          requestImageUpload={requestImageUpload}
          imageBaseUrl={imageBaseUrl}
          uploadToStorage={uploadToStorage}
          cardBusy={busy}
          onBusyChange={setBusy}
        />

        <form
          onSubmit={(e) => {
            void handleColorSubmit(e);
          }}
          className="space-y-3 border-t border-outline pt-6"
          noValidate
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor={colorId}>Brand color (hex)</Label>
              <Input
                id={colorId}
                type="text"
                value={color}
                onChange={(e) => {
                  setColor(e.target.value);
                }}
                placeholder="#1A4314"
                disabled={busy}
                aria-invalid={color !== '' && !swatchValid ? 'true' : undefined}
              />
            </div>
            <div
              aria-hidden="true"
              className="h-10 w-10 rounded-lg border border-outline"
              style={
                swatchValid
                  ? { backgroundColor: color }
                  : {
                      background:
                        'repeating-linear-gradient(45deg, #f1f5f9 0 6px, #e2e8f0 6px 12px)',
                    }
              }
              data-testid="brand-color-swatch"
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="min-h-[1.25rem]">
              {colorError !== null ? (
                <p role="alert" className="text-sm font-medium text-danger">
                  {colorError}
                </p>
              ) : colorSaved ? (
                <p role="status" className="text-sm font-medium text-moss-700">
                  Color saved.
                </p>
              ) : null}
            </div>
            <Button type="submit" disabled={!colorDirty || busy}>
              {savingColor ? (
                <>
                  <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                'Save color'
              )}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

interface BrandImageFieldProps {
  readonly field: 'heroImageKey' | 'logoImageKey';
  readonly label: string;
  readonly description: string;
  readonly imageKey: string | null;
  readonly aspectClass: string;
  readonly onPatch: VendorSettingsActions['patch'];
  readonly onPatched: (settings: VendorSettings) => void;
  readonly requestImageUpload: VendorSettingsActions['requestImageUpload'];
  readonly imageBaseUrl?: string;
  readonly uploadToStorage?: typeof uploadImageToStorage;
  /** True when any sibling control (other image, color) is mid-commit. */
  readonly cardBusy: boolean;
  /** Raise/lower the shared card gate around this field's own commit. */
  readonly onBusyChange: (busy: boolean) => void;
}

function BrandImageField({
  field,
  label,
  description,
  imageKey,
  aspectClass,
  onPatch,
  onPatched,
  requestImageUpload,
  imageBaseUrl,
  uploadToStorage,
  cardBusy,
  onBusyChange,
}: BrandImageFieldProps): ReactNode {
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // `cardBusy` disables this field while a sibling commits; `uploading`/
  // `removing` drive this field's own spinners.
  const busy = cardBusy || uploading || removing;
  const previewUrl = imageKey === null ? null : listingImageUrl(imageKey, imageBaseUrl);

  const patchKey = useCallback(
    (key: string | null): Promise<VendorSettings> =>
      onPatch(field === 'heroImageKey' ? { heroImageKey: key } : { logoImageKey: key }),
    [field, onPatch],
  );

  const handleFileSelected = useCallback(
    async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
      const file = event.target.files?.[0];
      // Reset so re-selecting the same file fires `change` again.
      event.target.value = '';
      if (file === undefined) return;
      if (!isUploadableImageType(file.type)) {
        setError('Use a JPEG, PNG, or WebP image.');
        return;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setError('Image must be 5 MB or smaller.');
        return;
      }
      setUploading(true);
      onBusyChange(true);
      setError(null);
      try {
        const ticket = await requestImageUpload(file.type);
        const upload = uploadToStorage ?? uploadImageToStorage;
        const key = await upload(ticket, file);
        const updated = await patchKey(key);
        onPatched(updated);
      } catch (err) {
        setError(extractError(err, "Couldn't upload that image. Try again."));
      } finally {
        setUploading(false);
        onBusyChange(false);
      }
    },
    [onBusyChange, onPatched, patchKey, requestImageUpload, uploadToStorage],
  );

  const handleRemove = useCallback(async (): Promise<void> => {
    setRemoving(true);
    onBusyChange(true);
    setError(null);
    try {
      const updated = await patchKey(null);
      onPatched(updated);
    } catch (err) {
      setError(extractError(err, "Couldn't remove that image. Try again."));
    } finally {
      setRemoving(false);
      onBusyChange(false);
    }
  }, [onBusyChange, onPatched, patchKey]);

  return (
    <section aria-label={label} className="space-y-2.5" data-testid={`brand-image-${field}`}>
      <div>
        <h3 className="text-sm font-semibold text-foreground">{label}</h3>
        <p className="text-xs text-muted">{description}</p>
      </div>

      <div
        className={`relative w-full overflow-hidden rounded-xl border border-outline bg-surface-subtle ${aspectClass}`}
      >
        {previewUrl !== null ? (
          <img src={previewUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : imageKey !== null ? (
          <div className="flex h-full w-full items-center justify-center p-3 text-center text-2xs text-muted">
            <span className="break-all">{imageKey.split('/').pop() ?? imageKey}</span>
          </div>
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted">
            <ImagePlus aria-hidden="true" className="h-6 w-6" />
            <span className="text-2xs">No image yet</span>
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT_ATTR}
        className="sr-only"
        data-testid={`brand-image-input-${field}`}
        onChange={(e) => {
          void handleFileSelected(e);
        }}
      />
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => {
            fileInputRef.current?.click();
          }}
          data-testid={`brand-image-upload-${field}`}
        >
          {uploading ? (
            <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
          ) : (
            <ImagePlus aria-hidden="true" className="h-4 w-4" />
          )}
          {uploading ? 'Uploading…' : imageKey === null ? 'Upload image' : 'Replace'}
        </Button>
        {imageKey !== null ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              void handleRemove();
            }}
            data-testid={`brand-image-remove-${field}`}
          >
            {removing ? (
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 aria-hidden="true" className="h-4 w-4" />
            )}
            Remove
          </Button>
        ) : null}
      </div>

      {error !== null ? (
        <p role="alert" className="text-xs text-danger" data-testid={`brand-image-error-${field}`}>
          {error}
        </p>
      ) : null}
    </section>
  );
}

/**
 * Surface a readable message from a failed brand mutation. Errors arrive here
 * across the Next.js server-action boundary, which serializes rejections to
 * plain `Error` (the `ApiError` prototype + status/envelope are lost), so we
 * key off `message` — the API's typed 422/403 text rides through as the
 * message — and fall back to a friendly default when it's empty. The only
 * client-thrown error (the direct-to-R2 `ImageUploadError`) also has a
 * message, so it takes the same path.
 */
function extractError(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim() !== '') return err.message;
  return fallback;
}
