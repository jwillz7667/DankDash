/**
 * Persist a batch of driver-location pings.
 *
 * Two writes per flush:
 *
 *   1. `driver_location_history.recordBatch(...)` — bulk insert covering
 *      every envelope in the batch. The table is weekly-partitioned and
 *      append-only; duplicate inserts (replay from XCLAIM recovery) are
 *      benign because the PK is `(id, recorded_at)` and `id` is a
 *      bigserial, so two history rows for the same envelope merely
 *      double-count in a query that filters on driverId. The tracker UI
 *      reads `latestForOrder` ordered by recordedAt DESC LIMIT N, so a
 *      replay-induced duplicate at the same instant looks identical to
 *      the user.
 *
 *   2. `drivers.updateLocation(driverId, location, recordedAt)` — one
 *      UPDATE per *unique* driver, using only the *latest* (largest
 *      recordedAt) point in the batch. The repo guards against
 *      out-of-order writes (`WHERE current_location_updated_at < $stamp`)
 *      so a stale replay cannot overwrite a fresher current location.
 *
 *      Why per-driver dedup before the UPDATE: a driver pinging at 1Hz
 *      whose batch is flushed at 500ms will appear in the batch ~once.
 *      A flapping client pinging multiple times within the flush window
 *      should still only generate one UPDATE — Postgres would happily
 *      run N UPDATEs in sequence and the WAL would record N noisy
 *      writes for the same final value. Coalescing in TS removes that
 *      noise without touching the DB layer.
 *
 * History inserts happen *before* current-location updates. A failure
 * partway through (history succeeded, current-location did not) leaves
 * the tracker UI stale-but-correct (the trail catches up; the marker
 * lags one tick); the inverse order would mean a customer's tracker
 * jumps to a location that has no history backing it, which is the
 * worse UX. Either failure mode triggers the consumer's not-ACK +
 * XCLAIM recovery on the next pass.
 */
import { type DriversRepository, type DriverLocationHistoryRepository } from '@dankdash/db';
import type { LocationIngestItem } from './types.js';

export interface LocationWriterDeps {
  readonly drivers: DriversRepository;
  readonly history: DriverLocationHistoryRepository;
}

export interface LocationWriteSummary {
  /** Rows written to driver_location_history. */
  readonly historyRows: number;
  /** Unique drivers whose current_location was patched. */
  readonly driversUpdated: number;
}

export async function writeLocationBatch(
  deps: LocationWriterDeps,
  items: readonly LocationIngestItem[],
): Promise<LocationWriteSummary> {
  if (items.length === 0) {
    return { historyRows: 0, driversUpdated: 0 };
  }

  // ------- 1. driver_location_history bulk insert -------
  await deps.history.recordBatch(
    items.map((item) => ({
      driverId: item.payload.driverId,
      orderId: item.payload.orderId,
      location: {
        type: 'Point',
        coordinates: [item.payload.lng, item.payload.lat],
      },
      accuracyMeters:
        item.payload.accuracyMeters === null ? null : item.payload.accuracyMeters.toFixed(2),
      speedMps: item.payload.speedMps === null ? null : item.payload.speedMps.toFixed(2),
      headingDeg: item.payload.headingDeg === null ? null : item.payload.headingDeg.toFixed(2),
      batteryPct: null,
      recordedAt: new Date(item.payload.recordedAt),
    })),
  );

  // ------- 2. drivers.current_location patch (latest per driver) -------
  const latestByDriver = new Map<string, LocationIngestItem>();
  for (const item of items) {
    const prev = latestByDriver.get(item.payload.driverId);
    if (prev === undefined) {
      latestByDriver.set(item.payload.driverId, item);
      continue;
    }
    if (new Date(item.payload.recordedAt) > new Date(prev.payload.recordedAt)) {
      latestByDriver.set(item.payload.driverId, item);
    }
  }

  await Promise.all(
    Array.from(latestByDriver.values()).map((item) =>
      deps.drivers.updateLocation(
        item.payload.driverId,
        { type: 'Point', coordinates: [item.payload.lng, item.payload.lat] },
        new Date(item.payload.recordedAt),
      ),
    ),
  );

  return {
    historyRows: items.length,
    driversUpdated: latestByDriver.size,
  };
}
