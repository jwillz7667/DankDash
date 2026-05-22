/**
 * Fold a polling-fallback snapshot into the live queue state.
 *
 * When the realtime socket drops to `disconnected`/`error` long enough
 * for the grace window to expire (see `useQueueSnapshotPolling` in
 * `lib/realtime/polling-fallback.ts`), the board polls
 * `GET /v1/vendor/orders` on a fixed interval. The polled list is the
 * authoritative active queue at the moment the server answered — it
 * accounts for every order that arrived, was accepted, was rejected,
 * or fell off the queue surface while the socket was down.
 *
 * The merge is replace-semantics on the *set* of orders (rows missing
 * from the polled list are dropped, rows missing from the local list
 * are added), but row-identity-preserving on the *individual* rows:
 *
 *   - If a polled row matches a local row id-for-id with the same
 *     content, the *local* reference is kept. That preserves `===`
 *     for any consumer that bails out of work when the row is
 *     unchanged (e.g. a future `React.memo` on `QueueCard`).
 *   - If every polled row matches the local snapshot row-for-row in
 *     the same order, the *local array* reference is returned. That
 *     lets `useMemo` deps keyed on the orders array skip re-running.
 *
 * The function is pure — no side effects, no allocations on the
 * no-change fast path. Tests live alongside in `snapshot-merge.test.ts`.
 */
import type { VendorQueueOrderSummary } from '../api/vendor-orders.js';

/**
 * Shallow equality across the fields the kanban renders. We
 * deliberately don't deep-compare the full row — anything past the
 * card surface (per-state timestamps) can drift without us caring
 * about ref identity, because the queue card never reads it. If a
 * field is added to the card's render set, extend this list too.
 */
function rowEqual(a: VendorQueueOrderSummary, b: VendorQueueOrderSummary): boolean {
  return (
    a.id === b.id &&
    a.shortCode === b.shortCode &&
    a.userId === b.userId &&
    a.customerName === b.customerName &&
    a.status === b.status &&
    a.itemCount === b.itemCount &&
    a.subtotalCents === b.subtotalCents &&
    a.totalCents === b.totalCents &&
    a.placedAt === b.placedAt &&
    a.statusChangedAt === b.statusChangedAt &&
    a.acceptedAt === b.acceptedAt &&
    a.preppingAt === b.preppingAt &&
    a.preparedAt === b.preparedAt
  );
}

export function mergePolledSnapshot(
  local: readonly VendorQueueOrderSummary[],
  polled: readonly VendorQueueOrderSummary[],
): readonly VendorQueueOrderSummary[] {
  const localById = new Map<string, VendorQueueOrderSummary>();
  for (const row of local) {
    localById.set(row.id, row);
  }

  const sameLength = local.length === polled.length;
  let sameOrder = sameLength;
  const result: VendorQueueOrderSummary[] = [];

  for (let i = 0; i < polled.length; i += 1) {
    const polledRow = polled[i];
    if (polledRow === undefined) continue;
    const existing = localById.get(polledRow.id);
    if (existing !== undefined && rowEqual(existing, polledRow)) {
      result.push(existing);
    } else {
      result.push(polledRow);
      sameOrder = false;
    }
    if (sameOrder && local[i]?.id !== polledRow.id) {
      sameOrder = false;
    }
  }

  if (sameOrder) {
    // Every row matched id-and-content in the same position — the
    // local array is byte-equal to the polled array. Return the
    // existing ref so `useMemo` deps keyed on the snapshot don't fire.
    return local;
  }
  return result;
}
