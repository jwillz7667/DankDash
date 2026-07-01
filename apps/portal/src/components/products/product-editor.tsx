'use client';

/**
 * Full-field editor for a vendor-authored product — the surface that replaces
 * the thin listing "override" panel for products a store owns. A slide-over
 * (same overlay structure as ListingOverridePanel) with every product field:
 * identity, category/type/strain, potency + weight (decimal strings, never
 * float math), serving fields, effect/flavor tags, and photo uploads.
 *
 * Compliance: when productType is `beverage` the form surfaces the statutory
 * caps (≤10 mg THC/serving, ≤2 servings/container) and blocks a non-compliant
 * save client-side; the server re-validates regardless.
 *
 * Images use the shared presign → direct-to-R2 flow; uploaded keys accumulate
 * in form state and ride along with the create/patch payload (one save, no
 * orphaned-on-cancel writes).
 */
import { ImagePlus, Loader2, Trash2, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import { isUploadableImageType, uploadImageToStorage } from '../../lib/api/image-uploads.js';
import {
  type CreateVendorProductInput,
  type ProductCategory,
  type ProductType,
  type StrainType,
  type VendorProduct,
} from '../../lib/api/vendor-products.js';
import { listingImageUrl } from '../../lib/listings/images.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import type { VendorProductActions } from '../../lib/products/product-actions.js';

const PRODUCT_TYPES: readonly ProductType[] = [
  'flower',
  'preroll',
  'infused_preroll',
  'vape',
  'edible',
  'beverage',
  'concentrate',
  'tincture',
  'topical',
  'accessory',
  'seed',
  'clone',
];
const STRAIN_TYPES: readonly StrainType[] = ['indica', 'sativa', 'hybrid', 'cbd', 'balanced'];

const BEVERAGE_MAX_MG_PER_SERVING = 10;
const BEVERAGE_MAX_SERVINGS = 2;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 10;
const ACCEPT_ATTR = 'image/jpeg,image/png,image/webp';
const DECIMAL_RE = /^\d+(\.\d+)?$/u;
const SELECT_CLASS =
  'h-10 w-full rounded-md border border-outline bg-surface px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss-500 disabled:opacity-50';

export interface ProductEditorProps {
  /** The product to edit, or `null` to author a new one. */
  readonly product: VendorProduct | null;
  readonly categories: readonly ProductCategory[];
  readonly onClose: () => void;
  readonly onSaved: (product: VendorProduct) => void;
  readonly actions: Pick<VendorProductActions, 'create' | 'patch' | 'requestImageUpload'>;
  readonly imageBaseUrl?: string;
  readonly uploadToStorage?: typeof uploadImageToStorage;
}

interface FormState {
  brand: string;
  name: string;
  description: string;
  categoryId: string;
  productType: ProductType;
  strainType: '' | StrainType;
  thcMgPerUnit: string;
  cbdMgPerUnit: string;
  weightGramsPerUnit: string;
  servingCount: string;
  thcMgPerServing: string;
  effectsTags: string;
  flavorTags: string;
  imageKeys: readonly string[];
}

function seed(product: VendorProduct | null, categories: readonly ProductCategory[]): FormState {
  if (product === null) {
    return {
      brand: '',
      name: '',
      description: '',
      categoryId: categories[0]?.id ?? '',
      productType: 'flower',
      strainType: '',
      thcMgPerUnit: '',
      cbdMgPerUnit: '',
      weightGramsPerUnit: '',
      servingCount: '',
      thcMgPerServing: '',
      effectsTags: '',
      flavorTags: '',
      imageKeys: [],
    };
  }
  return {
    brand: product.brand,
    name: product.name,
    description: product.description ?? '',
    categoryId: product.categoryId,
    productType: product.productType,
    strainType: product.strainType ?? '',
    thcMgPerUnit: product.thcMgPerUnit,
    cbdMgPerUnit: product.cbdMgPerUnit,
    weightGramsPerUnit: product.weightGramsPerUnit,
    servingCount: product.servingCount === null ? '' : String(product.servingCount),
    thcMgPerServing: product.thcMgPerServing ?? '',
    effectsTags: product.effectsTags.join(', '),
    flavorTags: product.flavorTags.join(', '),
    imageKeys: product.imageKeys,
  };
}

function parseTags(raw: string): readonly string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
}

export function ProductEditor({
  product,
  categories,
  onClose,
  onSaved,
  actions,
  imageBaseUrl,
  uploadToStorage,
}: ProductEditorProps): ReactNode {
  const isEdit = product !== null;
  const [form, setForm] = useState<FormState>(() => seed(product, categories));
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setForm(seed(product, categories));
    setError(null);
  }, [product, categories]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  const set = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const isBeverage = form.productType === 'beverage';

  const handleFileSelected = useCallback(
    async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
      const file = event.target.files?.[0];
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
      if (form.imageKeys.length >= MAX_IMAGES) {
        setError(`A product can have at most ${MAX_IMAGES} images.`);
        return;
      }
      setUploading(true);
      setError(null);
      try {
        const ticket = await actions.requestImageUpload(file.type);
        const upload = uploadToStorage ?? uploadImageToStorage;
        const key = await upload(ticket, file);
        setForm((prev) => ({ ...prev, imageKeys: [...prev.imageKeys, key] }));
      } catch (err) {
        setError(extractMessage(err, "Couldn't upload that image. Try again."));
      } finally {
        setUploading(false);
      }
    },
    [actions, form.imageKeys.length, uploadToStorage],
  );

  const removeImage = useCallback((key: string): void => {
    setForm((prev) => ({ ...prev, imageKeys: prev.imageKeys.filter((k) => k !== key) }));
  }, []);

  const validate = useCallback((): string | null => {
    if (form.brand.trim() === '') return 'Brand is required.';
    if (form.name.trim() === '') return 'Name is required.';
    if (form.categoryId === '') return 'Pick a category.';
    if (!DECIMAL_RE.test(form.thcMgPerUnit)) return 'THC (mg per unit) must be a number like 875.000.';
    for (const [label, v] of [
      ['CBD', form.cbdMgPerUnit],
      ['Weight', form.weightGramsPerUnit],
      ['THC per serving', form.thcMgPerServing],
    ] as const) {
      if (v.trim() !== '' && !DECIMAL_RE.test(v)) return `${label} must be a number or blank.`;
    }
    if (form.servingCount.trim() !== '' && !/^\d+$/u.test(form.servingCount)) {
      return 'Servings per container must be a whole number or blank.';
    }
    if (isBeverage) {
      if (form.thcMgPerServing.trim() !== '' &&
        Number.parseFloat(form.thcMgPerServing) > BEVERAGE_MAX_MG_PER_SERVING) {
        return `Beverages cannot exceed ${BEVERAGE_MAX_MG_PER_SERVING}mg THC per serving.`;
      }
      if (form.servingCount.trim() !== '' &&
        Number.parseInt(form.servingCount, 10) > BEVERAGE_MAX_SERVINGS) {
        return `Beverages cannot exceed ${BEVERAGE_MAX_SERVINGS} servings per container.`;
      }
    }
    return null;
  }, [form, isBeverage]);

  const handleSubmit = useCallback(async (): Promise<void> => {
    const validationError = validate();
    if (validationError !== null) {
      setError(validationError);
      return;
    }
    setBusy(true);
    setError(null);
    const payload: CreateVendorProductInput = {
      categoryId: form.categoryId,
      brand: form.brand.trim(),
      name: form.name.trim(),
      description: form.description.trim() === '' ? null : form.description.trim(),
      productType: form.productType,
      strainType: form.strainType === '' ? null : form.strainType,
      thcMgPerUnit: form.thcMgPerUnit,
      cbdMgPerUnit: form.cbdMgPerUnit.trim() === '' ? '0' : form.cbdMgPerUnit,
      weightGramsPerUnit: form.weightGramsPerUnit.trim() === '' ? '0' : form.weightGramsPerUnit,
      servingCount: form.servingCount.trim() === '' ? null : Number.parseInt(form.servingCount, 10),
      thcMgPerServing: form.thcMgPerServing.trim() === '' ? null : form.thcMgPerServing,
      effectsTags: parseTags(form.effectsTags),
      flavorTags: parseTags(form.flavorTags),
      imageKeys: form.imageKeys,
    };
    try {
      const saved =
        product === null
          ? await actions.create(payload)
          : await actions.patch(product.id, payload);
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(extractMessage(err, "Couldn't save the product. Check the fields and retry."));
    } finally {
      setBusy(false);
    }
  }, [actions, form, onClose, onSaved, product, validate]);

  return (
    <div className="fixed inset-0 z-40" data-testid="product-editor-root">
      <button
        type="button"
        className="absolute inset-0 bg-surface-inverse/40 backdrop-blur-sm"
        aria-label="Close product editor"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="product-editor-title"
        data-testid="product-editor"
        className="absolute right-0 top-0 flex h-full w-full max-w-lg flex-col border-l border-outline bg-surface shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-outline px-6 py-4">
          <h2 id="product-editor-title" className="text-lg font-semibold text-foreground">
            {isEdit ? 'Edit product' : 'New product'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 items-center justify-center rounded-full text-muted hover:bg-surface-subtle"
          >
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <Field label="Brand">
            <Input value={form.brand} onChange={(e) => { set('brand', e.target.value); }} disabled={busy} />
          </Field>
          <Field label="Name">
            <Input value={form.name} onChange={(e) => { set('name', e.target.value); }} disabled={busy} />
          </Field>
          <Field label="Description">
            <textarea
              value={form.description}
              onChange={(e) => { set('description', e.target.value); }}
              disabled={busy}
              rows={3}
              className="w-full rounded-md border border-outline bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss-500 disabled:opacity-50"
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Category">
              <select
                value={form.categoryId}
                onChange={(e) => { set('categoryId', e.target.value); }}
                disabled={busy}
                className={SELECT_CLASS}
                data-testid="product-editor-category"
              >
                {categories.length === 0 ? <option value="">No categories</option> : null}
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Type">
              <select
                value={form.productType}
                onChange={(e) => { set('productType', e.target.value as ProductType); }}
                disabled={busy}
                className={SELECT_CLASS}
                data-testid="product-editor-type"
              >
                {PRODUCT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/gu, ' ')}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Strain">
              <select
                value={form.strainType}
                onChange={(e) => { set('strainType', e.target.value as '' | StrainType); }}
                disabled={busy}
                className={SELECT_CLASS}
              >
                <option value="">—</option>
                {STRAIN_TYPES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="THC (mg/unit)">
              <Input
                value={form.thcMgPerUnit}
                onChange={(e) => { set('thcMgPerUnit', e.target.value); }}
                disabled={busy}
                inputMode="decimal"
                placeholder="875.000"
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="CBD (mg/unit)">
              <Input
                value={form.cbdMgPerUnit}
                onChange={(e) => { set('cbdMgPerUnit', e.target.value); }}
                disabled={busy}
                inputMode="decimal"
                placeholder="0"
              />
            </Field>
            <Field label="Weight (g/unit)">
              <Input
                value={form.weightGramsPerUnit}
                onChange={(e) => { set('weightGramsPerUnit', e.target.value); }}
                disabled={busy}
                inputMode="decimal"
                placeholder="3.500"
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Servings / container">
              <Input
                value={form.servingCount}
                onChange={(e) => { set('servingCount', e.target.value); }}
                disabled={busy}
                inputMode="numeric"
                placeholder="—"
              />
            </Field>
            <Field label="THC (mg/serving)">
              <Input
                value={form.thcMgPerServing}
                onChange={(e) => { set('thcMgPerServing', e.target.value); }}
                disabled={busy}
                inputMode="decimal"
                placeholder="—"
              />
            </Field>
          </div>
          {isBeverage ? (
            <p className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning">
              Beverages are capped at {BEVERAGE_MAX_MG_PER_SERVING}mg THC per serving and{' '}
              {BEVERAGE_MAX_SERVINGS} servings per container (Minn. Stat. § 342.46).
            </p>
          ) : null}

          <Field label="Effects (comma-separated)">
            <Input
              value={form.effectsTags}
              onChange={(e) => { set('effectsTags', e.target.value); }}
              disabled={busy}
              placeholder="relaxed, happy"
            />
          </Field>
          <Field label="Flavors (comma-separated)">
            <Input
              value={form.flavorTags}
              onChange={(e) => { set('flavorTags', e.target.value); }}
              disabled={busy}
              placeholder="citrus, pine"
            />
          </Field>

          <div className="space-y-2">
            <Label>Photos</Label>
            {form.imageKeys.length > 0 ? (
              <ul className="grid grid-cols-3 gap-2" data-testid="product-editor-gallery">
                {form.imageKeys.map((key) => {
                  const url = listingImageUrl(key, imageBaseUrl);
                  return (
                    <li
                      key={key}
                      className="group relative aspect-square overflow-hidden rounded-lg border border-outline bg-surface-subtle"
                    >
                      {url !== null ? (
                        <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" />
                      ) : (
                        <span className="flex h-full items-center justify-center break-all p-1 text-2xs text-muted">
                          {key.split('/').pop()}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => { removeImage(key); }}
                        disabled={busy}
                        aria-label={`Remove image ${key}`}
                        className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-surface-inverse/70 text-on-primary"
                      >
                        <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT_ATTR}
              className="sr-only"
              data-testid="product-editor-file-input"
              onChange={(e) => {
                void handleFileSelected(e);
              }}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy || form.imageKeys.length >= MAX_IMAGES}
              onClick={() => fileInputRef.current?.click()}
              data-testid="product-editor-upload"
            >
              {uploading ? (
                <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              ) : (
                <ImagePlus aria-hidden="true" className="h-4 w-4" />
              )}
              {uploading ? 'Uploading…' : 'Upload photo'}
            </Button>
          </div>

          {error !== null ? (
            <p role="alert" className="text-sm font-medium text-danger" data-testid="product-editor-error">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex justify-end gap-2 border-t border-outline bg-surface-muted/40 px-6 py-4">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              void handleSubmit();
            }}
            disabled={busy || uploading}
            data-testid="product-editor-save"
          >
            {busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
            {isEdit ? 'Save product' : 'Create product'}
          </Button>
        </footer>
      </div>
    </div>
  );
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactNode {
  // Wrap the control in the <label> so it's associated for assistive tech (and
  // getByLabelText) without threading a generated id through every input.
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-secondary">{label}</span>
      {children}
    </label>
  );
}

function extractMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return fallback;
}
