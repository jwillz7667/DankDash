'use client';

/**
 * Vendor menu table. Owns the local snapshot of listings + sync banner,
 * dispatches inline edits through the {@link VendorListingActions}
 * interface, and merges the patched listing back into the table.
 *
 *   - Mirrors the queue-board pattern: seed from server-fetched
 *     `initialListings`, manage state via `useState`, refresh from
 *     `actions.list()` after a sync (since every active row's
 *     `lastSyncedAt` changes).
 *   - Sort is `updatedAt desc, createdAt desc` — same ordering the API
 *     returns. The merged-after-patch row's `updatedAt` lifts so the
 *     edited row floats to the top, matching the server's view if a
 *     vendor refreshes.
 *   - Empty state lives in the table because the layout is identical
 *     to the table header (so the "Add listing" CTA lines up cleanly
 *     under the column heads on wide screens).
 *
 * Search/filter live here; the override panel (richer per-listing edit:
 * images, SKU, compare-at, Metrc tag) is a sibling slide-over this table
 * opens. The table boundary owns the snapshot so both the inline cells
 * and the panel fold their patches back through the same `handlePatch`.
 */
import { DomainError, type ErrorDetails } from '@dankdash/types';
import { PackageOpen, Search } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  type PatchVendorListingInput,
  type SyncVendorListingsResult,
  type VendorListingWithProduct,
} from '../../lib/api/vendor-listings.js';
import { type VendorListingActions } from '../../lib/listings/listing-actions.js';
import { Input } from '../ui/input.js';
import { ListingOverridePanel } from './listing-override-panel.js';
import { MenuRow } from './menu-row.js';
import { SyncBanner } from './sync-banner.js';

/**
 * Programmer-error guard for the snapshot invariant: a row that the user
 * just edited has to exist in `listings`. Surfaces as a typed DomainError
 * to satisfy the workspace lint that forbids raw `throw new Error(...)`,
 * and to make this clearly an internal-bug code path (not a 4xx).
 */
class MenuSnapshotError extends DomainError {
  public readonly code = 'MENU_SNAPSHOT_ERROR';
  public readonly statusCode = 500;
  constructor(message: string, details: ErrorDetails = {}) {
    super(message, details);
  }
}

export interface MenuTableProps {
  readonly initialListings: readonly VendorListingWithProduct[];
  readonly actions: VendorListingActions;
  /** Public R2 base for image previews; undefined renders placeholders. */
  readonly imageBaseUrl?: string;
  /** Test seam — deterministic clock for sync labels. */
  readonly nowFactory?: () => Date;
}

export function MenuTable({
  initialListings,
  actions,
  imageBaseUrl,
  nowFactory,
}: MenuTableProps): ReactNode {
  const [listings, setListings] = useState<readonly VendorListingWithProduct[]>(() =>
    [...initialListings].sort(compareListings),
  );
  const [query, setQuery] = useState('');
  const [overrideListing, setOverrideListing] = useState<VendorListingWithProduct | null>(null);
  const now = nowFactory?.() ?? new Date();

  const oldestLastSyncedAt = useMemo<string | null>(() => {
    let candidate: string | null = null;
    let candidateMs = Number.POSITIVE_INFINITY;
    let anyActive = false;
    for (const listing of listings) {
      if (!listing.isActive) continue;
      anyActive = true;
      if (listing.lastSyncedAt === null) {
        // A never-synced active row makes the whole banner "never synced".
        return null;
      }
      const ms = Date.parse(listing.lastSyncedAt);
      if (Number.isNaN(ms)) continue;
      if (ms < candidateMs) {
        candidateMs = ms;
        candidate = listing.lastSyncedAt;
      }
    }
    if (!anyActive) return null;
    return candidate;
  }, [listings]);

  const handlePatch = useCallback(
    async (
      listingId: string,
      patch: PatchVendorListingInput,
    ): Promise<VendorListingWithProduct> => {
      const updated = await actions.patch(listingId, patch);
      const existing = listings.find((l) => l.id === listingId);
      if (existing === undefined) {
        // Table state is authoritative: only MenuRow can call this, and
        // MenuRow only renders rows in `listings`. The branch is a
        // snapshot-corruption guard, never a normal flow.
        throw new MenuSnapshotError('Patched listing not found in current snapshot', { listingId });
      }
      const merged: VendorListingWithProduct = {
        ...existing,
        ...updated,
        product: existing.product,
      };
      setListings((prev) => {
        const next = prev.map((row) => (row.id === listingId ? merged : row));
        next.sort(compareListings);
        return next;
      });
      return merged;
    },
    [actions, listings],
  );

  const handleSync = useCallback(async (): Promise<SyncVendorListingsResult> => {
    return actions.sync();
  }, [actions]);

  const handleSyncCompleted = useCallback(async (): Promise<void> => {
    try {
      const next = await actions.list();
      setListings(next);
    } catch (e) {
      // The banner already showed success; this list refresh is cosmetic,
      // so a failure is intentionally not surfaced to the user. Bind and
      // explicitly discard the error (mirrors menu-row.tsx) — the next
      // manual interaction re-fetches on its own via patch.
      void e;
    }
  }, [actions]);

  const filtered = useMemo<readonly VendorListingWithProduct[]>(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return listings;
    return listings.filter((l) => {
      return (
        l.sku.toLowerCase().includes(q) ||
        l.product.brand.toLowerCase().includes(q) ||
        l.product.name.toLowerCase().includes(q)
      );
    });
  }, [listings, query]);

  return (
    <div className="flex flex-col gap-4">
      <SyncBanner
        oldestLastSyncedAt={oldestLastSyncedAt}
        onSync={handleSync}
        onSyncCompleted={() => {
          void handleSyncCompleted();
        }}
        now={now}
      />

      <div className="rounded-2xl border border-outline bg-surface shadow-sm">
        <div className="flex flex-col gap-3 border-b border-outline-subtle px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold tracking-tight text-foreground">Listings</h2>
            <p className="text-sm text-muted">
              Every SKU your store offers. Click a price or quantity to edit; toggle the switch to
              show or hide a listing on the public menu.
            </p>
          </div>
          <label className="relative block">
            <span className="sr-only">Filter listings</span>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
            />
            <Input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
              }}
              placeholder="Search SKU, brand, or product"
              className="h-9 w-full pl-9 text-sm sm:w-72"
            />
          </label>
        </div>

        {listings.length === 0 ? (
          <EmptyState />
        ) : filtered.length === 0 ? (
          <NoMatchesState
            query={query}
            onClear={() => {
              setQuery('');
            }}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="menu-table">
              <thead className="border-b border-outline-subtle bg-surface-muted/50 text-2xs font-medium uppercase tracking-wider text-muted">
                <tr>
                  <th scope="col" className="py-3 pl-5 pr-3">
                    Product
                  </th>
                  <th scope="col" className="px-3 py-3 text-right">
                    Price
                  </th>
                  <th scope="col" className="px-3 py-3 text-right">
                    Qty
                  </th>
                  <th scope="col" className="px-3 py-3 text-center">
                    Active
                  </th>
                  <th scope="col" className="px-3 py-3 text-left">
                    Sync
                  </th>
                  <th scope="col" className="pl-3 pr-5 py-3 text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((listing) => (
                  <MenuRow
                    key={listing.id}
                    listing={listing}
                    onPatch={handlePatch}
                    onOpenOverride={setOverrideListing}
                    imageBaseUrl={imageBaseUrl}
                    now={now}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ListingOverridePanel
        listing={overrideListing}
        onClose={() => {
          setOverrideListing(null);
        }}
        onPatch={handlePatch}
        requestImageUpload={actions.requestImageUpload}
        imageBaseUrl={imageBaseUrl}
      />
    </div>
  );
}

function compareListings(a: VendorListingWithProduct, b: VendorListingWithProduct): number {
  const u = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  if (u !== 0) return u;
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

function EmptyState(): ReactNode {
  return (
    <div className="flex flex-col items-center gap-3 px-5 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-moss-50 text-moss-700">
        <PackageOpen aria-hidden="true" className="h-5 w-5" />
      </div>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold tracking-tight text-foreground">No listings yet</h3>
        <p className="max-w-sm text-sm text-muted">
          Once your products are in the global catalog, list them here with a price and inventory to
          start selling.
        </p>
      </div>
    </div>
  );
}

function NoMatchesState({
  query,
  onClear,
}: {
  readonly query: string;
  readonly onClear: () => void;
}): ReactNode {
  return (
    <div className="flex flex-col items-center gap-3 px-5 py-12 text-center">
      <p className="text-sm text-muted">
        No listings matched <span className="font-medium text-secondary">"{query}"</span>.
      </p>
      <button
        type="button"
        onClick={onClear}
        className="rounded-md text-sm font-medium text-moss-700 hover:text-moss-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss-500"
      >
        Clear filter
      </button>
    </div>
  );
}
