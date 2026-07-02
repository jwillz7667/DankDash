/**
 * Online-idle location ingest → dispatch visibility — integration test
 * against a real Postgres+PostGIS testcontainer.
 *
 * Proves the end-to-end invariant this feature depends on: a driver who is
 * on shift but NOT on a delivery emits `driver:location:update`, the realtime
 * service republishes a `driver:location` envelope with `orderId = null`,
 * and the workers location-ingest writer must still refresh
 * `drivers.current_location` — the exact column
 * `DriversRepository.findDispatchCandidatesNearDispensary` reads (filtered by
 * `current_order_id IS NULL`). If the writer ever gated the current-location
 * write on an order id, idle drivers would silently vanish from open-pool
 * radius + offer scoring; this test would catch that.
 *
 * Exercises the production writer (`writeLocationBatch`) with the real
 * `DriversRepository` / `DriverLocationHistoryRepository` — no fakes — so
 * schema↔code drift surfaces here. Redis and the stream consumer are
 * covered by the unit suite; this test starts from a decoded envelope.
 */
import {
  DriverLocationHistoryRepository,
  DriversRepository,
  createPool,
  seed,
  stableUuid,
  type Pool,
} from '@dankdash/db';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeLocationBatch } from '../../src/jobs/location-ingest/location-ingest.writer.js';
import type { LocationIngestItem } from '../../src/jobs/location-ingest/types.js';

const LOGGER = pino({ level: 'silent' });

// North Loop Cannabis (mpls) seed location — see @dankdash/db seed fixtures.
const MPLS_ID = stableUuid('dispensary', 'mpls');
const MPLS_LNG = -93.273;
const MPLS_LAT = 44.987;
// 10 miles, the dispatch default radius (spec §8.3).
const RADIUS_METERS = 10 * 1609.344;

class TestEnvNotSetError extends Error {
  public override readonly name = 'TestEnvNotSetError';
  constructor() {
    super('TEST_DATABASE_URL is not set. Did the vitest globalSetup run?');
  }
}

function idlePing(
  driverId: string,
  lng: number,
  lat: number,
  recordedAt: string,
): LocationIngestItem {
  return {
    streamId: '0-0',
    payload: {
      driverId,
      // The crux: an online-idle driver has no active delivery, so the
      // realtime service resolves null ids and publishes them verbatim.
      orderId: null,
      customerId: null,
      dispensaryId: null,
      lat,
      lng,
      accuracyMeters: 8,
      speedMps: null,
      headingDeg: null,
      recordedAt,
    },
  };
}

let pool: Pool;
let drivers: DriversRepository;
let history: DriverLocationHistoryRepository;
let driverId: string;

describe('location-ingest → dispatch (online-idle) integration', () => {
  beforeAll(async () => {
    const url = process.env['TEST_DATABASE_URL'];
    if (url === undefined || url.length === 0) throw new TestEnvNotSetError();
    pool = createPool({
      databaseUrl: url,
      logger: LOGGER,
      maxConnections: 4,
      prepare: false,
      slowQueryThresholdMs: 10_000,
    });
    await seed({ db: pool.db, logger: LOGGER, truncate: true });

    drivers = new DriversRepository(pool.db);
    history = new DriverLocationHistoryRepository(pool.db);

    const driver = await drivers.findByUserId(stableUuid('user', 'driver-1'));
    expect(driver).not.toBeNull();
    driverId = driver!.id;

    // On shift, accepting work, no delivery in flight — the online-idle state.
    await drivers.setStatus(driverId, 'online');
  });

  afterAll(async () => {
    await pool.close();
  });

  it('makes an idle driver a dispatch candidate at the ingested position', async () => {
    // Anchor to "now" so the weekly-partitioned history table always has a
    // partition for the insert (partitions are bootstrapped from the current
    // ISO week forward).
    const now = Date.now();

    // First idle ping: right at the dispensary.
    const summary = await writeLocationBatch({ drivers, history }, [
      idlePing(driverId, MPLS_LNG, MPLS_LAT, new Date(now).toISOString()),
    ]);
    expect(summary).toEqual({ historyRows: 1, driversUpdated: 1 });

    const located = await drivers.findById(driverId);
    expect(located?.currentLocation?.coordinates).toEqual([MPLS_LNG, MPLS_LAT]);

    const candidates = await drivers.findDispatchCandidatesNearDispensary(MPLS_ID, RADIUS_METERS);
    const me = candidates.find((c) => c.driverId === driverId);
    expect(
      me,
      'idle driver must be a dispatch candidate once current_location is set',
    ).toBeDefined();
    expect(me!.distanceMeters).toBeLessThan(50);
  });

  it('refreshes the position dispatch scores as the idle driver moves', async () => {
    // A later ping ~2.1 km west — still inside the radius, but the scored
    // distance must reflect the NEW position, proving idle ingest keeps
    // `drivers.current_location` fresh rather than pinning the shift-start seed.
    const later = new Date(Date.now() + 60_000).toISOString();
    await writeLocationBatch({ drivers, history }, [idlePing(driverId, -93.3, MPLS_LAT, later)]);

    const candidates = await drivers.findDispatchCandidatesNearDispensary(MPLS_ID, RADIUS_METERS);
    const me = candidates.find((c) => c.driverId === driverId);
    expect(me, 'still a candidate after moving within the radius').toBeDefined();
    expect(me!.distanceMeters).toBeGreaterThan(1_500);
    expect(me!.distanceMeters).toBeLessThan(3_000);
  });
});
