/**
 * Response shape for `POST /v1/vendor/listings/sync`.
 *
 * The portal's manual-sync affordance is the only path that calls this
 * today. Async POS reconciliation (Treez / Dutchie / Metrc inventory
 * pull) lands in a follow-up phase; the contract intentionally returns
 * the same envelope so a future async sync can replace the synchronous
 * "stamp lastSyncedAt and call it done" implementation without changing
 * the wire shape.
 *
 *   `updated`  — count of active listings whose `lastSyncedAt` advanced
 *                in this run. The vendor sees this as "synced N listings."
 *   `syncedAt` — ISO timestamp the sync completed. The portal threads
 *                this into the menu table so every row's age recalculates
 *                without a list-refetch.
 */
import { z } from 'zod';

export const SyncListingsResponseSchema = z
  .object({
    updated: z.number().int().nonnegative(),
    syncedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type SyncListingsResponse = z.infer<typeof SyncListingsResponseSchema>;
