'use client';

/**
 * POS sync banner that sits above the menu table. Surfaces the oldest
 * `lastSyncedAt` across the dispensary's *active* listings (a single
 * stale listing should not pollute the headline number for the whole
 * store), and exposes a "Sync now" affordance that flips
 * `lastSyncedAt = now` on every active row.
 *
 * Stays a client component because the staleness label needs to refresh
 * without a server round-trip, and the sync action is interactive.
 *
 *   - "Synced just now" / "Synced 12m ago" — fresh (< 1h).
 *   - "Synced 4h ago"                       — aging (1–24h).
 *   - "Synced May 18"                       — stale (≥ 24h).
 *   - "Never synced"                        — no `lastSyncedAt` anywhere.
 *
 * The button shows a spinner during the round-trip and disables itself
 * to prevent double-fires; a failed sync surfaces a transient error
 * paragraph below the banner.
 */
import { RefreshCw } from 'lucide-react';
import { useCallback, useState, type ReactNode } from 'react';
import { type SyncVendorListingsResult } from '../../lib/api/vendor-listings.js';
import { formatSyncedLabel, syncStaleness } from '../../lib/listings/format.js';
import { Badge, type BadgeTone } from '../ui/badge.js';
import { Button } from '../ui/button.js';

const TONE_BY_STALENESS: Record<ReturnType<typeof syncStaleness>, BadgeTone> = {
  fresh: 'success',
  aging: 'warning',
  stale: 'danger',
  never: 'neutral',
};

export interface SyncBannerProps {
  /**
   * Oldest `lastSyncedAt` across active listings, or `null` if none have
   * ever synced. The page-level component computes this once from the
   * snapshot so the banner doesn't have to know the listings layout.
   */
  readonly oldestLastSyncedAt: string | null;
  /** Server action that triggers the sync. Resolves to the new timestamp. */
  readonly onSync: () => Promise<SyncVendorListingsResult>;
  /**
   * Called after a successful sync so the parent can update the snapshot
   * (i.e. re-fetch the listings, which now carry the new timestamps).
   */
  readonly onSyncCompleted?: (result: SyncVendorListingsResult) => void;
  /**
   * Test seam — production uses `new Date()`. Tests inject a deterministic
   * clock so the label is stable.
   */
  readonly now?: Date;
}

export function SyncBanner({
  oldestLastSyncedAt,
  onSync,
  onSyncCompleted,
  now,
}: SyncBannerProps): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clock = now ?? new Date();
  const tone = TONE_BY_STALENESS[syncStaleness(oldestLastSyncedAt, clock)];
  const label = formatSyncedLabel(oldestLastSyncedAt, clock);

  const handleSync = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await onSync();
      onSyncCompleted?.(result);
    } catch (e) {
      // We don't surface raw error messages — the operator's recovery
      // is the same regardless of the underlying cause (retry or call
      // support). The full envelope is logged server-side.
      void e;
      setError("Couldn't sync the menu. Try again, or reach out to DankDash support.");
    } finally {
      setBusy(false);
    }
  }, [onSync, onSyncCompleted]);

  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex flex-col gap-3 rounded-2xl border border-outline bg-surface px-5 py-4 shadow-sm sm:flex-row sm:items-center sm:justify-between"
        data-testid="sync-banner"
      >
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold tracking-tight text-foreground">POS sync</h2>
            <Badge tone={tone} aria-label={`sync ${tone}`}>
              {label}
            </Badge>
          </div>
          <p className="text-sm text-muted">
            One-click sync stamps every active listing as just-reconciled. Manual edits made since
            the last sync are preserved — this only updates the freshness signal.
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={() => void handleSync()}
          disabled={busy}
          aria-label="Sync menu with POS"
        >
          <RefreshCw aria-hidden="true" className={busy ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          {busy ? 'Syncing…' : 'Sync now'}
        </Button>
      </div>
      {error !== null ? (
        <p role="alert" className="px-1 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
