'use client';

/**
 * Single row of the menu table. Renders product info on the left and
 * three inline-editable cells: price, quantity, active toggle. The
 * Metrc tag, sync timestamp, and override button live in the trailing
 * cells.
 *
 *   - Price / qty use click-to-edit: click the displayed value to
 *     open an inline `<input>`; Enter commits, Escape rolls back.
 *   - Active is a checkbox-style switch; flipping it fires
 *     `actions.patch(id, { isActive })` immediately.
 *   - On save, the row enters a "saving…" state. The patch returns the
 *     updated listing — we merge the listing fields over the local row
 *     and keep the product reference (the product doesn't change).
 *   - On error, the value reverts and a transient error message renders
 *     under the row. We don't show raw error messages — the operator's
 *     recovery is the same regardless.
 *
 * The row deliberately does NOT manage the table snapshot — the parent
 * component owns the listings array and merges the patched listing
 * back via `onUpdated`. Keeping snapshot-merge logic out of the row
 * leaves the row testable in isolation.
 */
import { Pencil, Tag, Check, X, Loader2 } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import {
  type PatchVendorListingInput,
  type VendorListingWithProduct,
} from '../../lib/api/vendor-listings.js';
import {
  formatCentsForInput,
  formatSyncedLabel,
  parseInputToCents,
  parseInputToQuantity,
  syncStaleness,
} from '../../lib/listings/format.js';
import { formatMoney } from '../../lib/orders/format.js';
import { Badge, type BadgeTone } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';

const STALENESS_TONE: Record<ReturnType<typeof syncStaleness>, BadgeTone> = {
  fresh: 'success',
  aging: 'warning',
  stale: 'danger',
  never: 'neutral',
};

export interface MenuRowProps {
  readonly listing: VendorListingWithProduct;
  /** Patch the listing on the server. Returns the merged listing. */
  readonly onPatch: (
    listingId: string,
    patch: PatchVendorListingInput,
  ) => Promise<VendorListingWithProduct>;
  /** Open the override panel for a richer edit (SKU, compareAt, Metrc tag). */
  readonly onOpenOverride?: (listing: VendorListingWithProduct) => void;
  /** Deterministic clock for the sync-staleness label. */
  readonly now?: Date;
}

type FieldKey = 'price' | 'quantity';

export function MenuRow({ listing, onPatch, onOpenOverride, now }: MenuRowProps): ReactNode {
  const clock = now ?? new Date();
  const [editing, setEditing] = useState<FieldKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const productOutOfCatalog = !listing.product.isActive || listing.product.deletedAt !== null;

  const handlePatch = useCallback(
    async (patch: PatchVendorListingInput) => {
      setBusy(true);
      setError(null);
      try {
        await onPatch(listing.id, patch);
        setEditing(null);
      } catch (e) {
        void e;
        setError("Couldn't save. Try again, or check your connection.");
      } finally {
        setBusy(false);
      }
    },
    [listing.id, onPatch],
  );

  const handleToggleActive = useCallback(() => {
    void handlePatch({ isActive: !listing.isActive });
  }, [handlePatch, listing.isActive]);

  return (
    <tr
      data-testid="menu-row"
      data-listing-id={listing.id}
      className="border-b border-slate-100 align-middle last:border-0"
    >
      <td className="py-3 pl-5 pr-3">
        <div className="flex items-center gap-3">
          <ProductThumb listing={listing} />
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-semibold text-slate-900">
                {listing.product.brand} — {listing.product.name}
              </p>
              {productOutOfCatalog ? (
                <Badge tone="warning" aria-label="product archived globally">
                  Archived
                </Badge>
              ) : null}
            </div>
            <p className="truncate text-xs text-slate-500">
              <span className="inline-flex items-center gap-1">
                <Tag aria-hidden="true" className="h-3 w-3" />
                {listing.sku}
              </span>
              <span className="mx-1.5 text-slate-300">·</span>
              <span className="capitalize">{listing.product.productType}</span>
              {listing.product.strainType !== null ? (
                <>
                  <span className="mx-1.5 text-slate-300">·</span>
                  <span className="capitalize">{listing.product.strainType}</span>
                </>
              ) : null}
            </p>
          </div>
        </div>
      </td>

      <td className="py-3 px-3 text-right tabular-nums">
        <EditableCell
          field="price"
          editing={editing === 'price'}
          busy={busy && editing === 'price'}
          display={formatMoney(listing.priceCents)}
          initialValue={formatCentsForInput(listing.priceCents)}
          inputAriaLabel="Edit price"
          prefix="$"
          onEdit={() => {
            setEditing('price');
          }}
          onCancel={() => {
            setEditing(null);
          }}
          onCommit={(raw) => {
            const cents = parseInputToCents(raw);
            if (cents === null || cents <= 0) {
              setError('Price must be a positive number.');
              return Promise.resolve();
            }
            if (cents === listing.priceCents) {
              setEditing(null);
              return Promise.resolve();
            }
            return handlePatch({ priceCents: cents });
          }}
        />
      </td>

      <td className="py-3 px-3 text-right tabular-nums">
        <EditableCell
          field="quantity"
          editing={editing === 'quantity'}
          busy={busy && editing === 'quantity'}
          display={String(listing.quantityAvailable)}
          initialValue={String(listing.quantityAvailable)}
          inputAriaLabel="Edit quantity available"
          onEdit={() => {
            setEditing('quantity');
          }}
          onCancel={() => {
            setEditing(null);
          }}
          onCommit={(raw) => {
            const qty = parseInputToQuantity(raw);
            if (qty === null) {
              setError('Quantity must be a non-negative integer.');
              return Promise.resolve();
            }
            if (qty === listing.quantityAvailable) {
              setEditing(null);
              return Promise.resolve();
            }
            return handlePatch({ quantityAvailable: qty });
          }}
        />
      </td>

      <td className="py-3 px-3 text-center">
        <ActiveToggle
          isActive={listing.isActive}
          busy={busy && editing === null}
          onToggle={handleToggleActive}
        />
      </td>

      <td className="py-3 px-3 text-left">
        <div className="flex flex-col">
          <Badge
            tone={STALENESS_TONE[syncStaleness(listing.lastSyncedAt, clock)]}
            aria-label="sync status"
          >
            {formatSyncedLabel(listing.lastSyncedAt, clock)}
          </Badge>
          {listing.metrcPackageTag !== null ? (
            <span className="mt-1 font-mono text-2xs text-slate-500" title="Metrc package tag">
              {listing.metrcPackageTag}
            </span>
          ) : null}
        </div>
      </td>

      <td className="py-3 pl-3 pr-5 text-right">
        {onOpenOverride !== undefined ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Override ${listing.sku}`}
            onClick={() => {
              onOpenOverride(listing);
            }}
          >
            <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
            Override
          </Button>
        ) : null}
        {error !== null ? (
          <p role="alert" className="mt-1 text-xs text-rose-700">
            {error}
          </p>
        ) : null}
      </td>
    </tr>
  );
}

function ProductThumb({ listing }: { readonly listing: VendorListingWithProduct }): ReactNode {
  const firstImage = listing.product.imageKeys[0];
  if (firstImage === undefined) {
    return (
      <div
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-2xs font-medium uppercase tracking-widest text-slate-400"
        aria-hidden="true"
      >
        {listing.product.brand.slice(0, 2)}
      </div>
    );
  }
  return (
    <div
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100"
      aria-hidden="true"
    >
      <img src={firstImage} alt="" className="h-10 w-10 rounded-lg object-cover" loading="lazy" />
    </div>
  );
}

interface EditableCellProps {
  readonly field: FieldKey;
  readonly editing: boolean;
  readonly busy: boolean;
  readonly display: string;
  readonly initialValue: string;
  readonly inputAriaLabel: string;
  readonly prefix?: string;
  readonly onEdit: () => void;
  readonly onCancel: () => void;
  readonly onCommit: (raw: string) => Promise<void>;
}

function EditableCell({
  field,
  editing,
  busy,
  display,
  initialValue,
  inputAriaLabel,
  prefix,
  onEdit,
  onCancel,
  onCommit,
}: EditableCellProps): ReactNode {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const inputId = useId();
  const [draft, setDraft] = useState(initialValue);

  useEffect(() => {
    if (editing) {
      setDraft(initialValue);
      // Defer focus until after the input mounts.
      queueMicrotask(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, initialValue]);

  const submit = useCallback(
    async (event?: SyntheticEvent) => {
      event?.preventDefault();
      await onCommit(draft);
    },
    [draft, onCommit],
  );

  if (!editing) {
    return (
      <button
        type="button"
        onClick={onEdit}
        data-field={field}
        aria-label={`${inputAriaLabel}, current value ${display}`}
        className="rounded px-2 py-1 text-sm font-medium text-slate-900 hover:bg-slate-100 focus-visible:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss-500"
      >
        {display}
      </button>
    );
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="flex items-center justify-end gap-1"
      data-field={field}
    >
      <div className="relative">
        {prefix !== undefined ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-sm text-slate-400"
          >
            {prefix}
          </span>
        ) : null}
        <Input
          ref={inputRef}
          id={inputId}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onCancel();
            }
          }}
          inputMode={field === 'quantity' ? 'numeric' : 'decimal'}
          disabled={busy}
          aria-label={inputAriaLabel}
          className={
            prefix !== undefined
              ? 'h-8 w-24 pl-5 text-right text-sm'
              : 'h-8 w-20 text-right text-sm'
          }
        />
      </div>
      <button
        type="submit"
        disabled={busy}
        aria-label={`Save ${field}`}
        className="rounded p-1 text-emerald-700 hover:bg-emerald-50 focus-visible:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss-500 disabled:opacity-50"
      >
        {busy ? (
          <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
        ) : (
          <Check aria-hidden="true" className="h-4 w-4" />
        )}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        aria-label={`Cancel ${field} edit`}
        className="rounded p-1 text-slate-500 hover:bg-slate-100 focus-visible:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss-500 disabled:opacity-50"
      >
        <X aria-hidden="true" className="h-4 w-4" />
      </button>
    </form>
  );
}

interface ActiveToggleProps {
  readonly isActive: boolean;
  readonly busy: boolean;
  readonly onToggle: () => void;
}

function ActiveToggle({ isActive, busy, onToggle }: ActiveToggleProps): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isActive}
      aria-label={isActive ? 'Listing active — deactivate' : 'Listing inactive — activate'}
      onClick={onToggle}
      disabled={busy}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss-500 focus-visible:ring-offset-2 disabled:opacity-50 ${
        isActive ? 'bg-moss-500' : 'bg-slate-300'
      }`}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          isActive ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}
