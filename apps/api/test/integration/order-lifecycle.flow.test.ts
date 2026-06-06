/**
 * Full order lifecycle — placed → … → delivered — end to end against
 * real Postgres through the canonical `OrderTransitionService` chokepoint
 * and the driver HTTP surface. This is the integration proof for the
 * order/delivery flow wiring closed in this branch:
 *
 *   1. Auto-dispatch (gap #1): the moment a vendor marks an order
 *      `ready_for_pickup`, `OrderDispatchQueueListener` fires the system
 *      `DISPATCH_QUEUE` event and the order advances to `awaiting_driver`
 *      with no further input. The listener runs post-commit on the
 *      `OrderTransitionedEvent` bus (async, fire-and-forget), so the test
 *      polls the row after `VENDOR_READY` commits rather than assuming a
 *      synchronous hop.
 *
 *   2. Dropoff legs (gap #2): the new `POST /depart` and `POST /arrive`
 *      driver endpoints advance `picked_up → en_route_dropoff →
 *      arrived_at_dropoff`. Driven over real HTTP so the controller →
 *      service → `OrderTransitionService` path is exercised, not just the
 *      service in isolation (which has its own unit tests).
 *
 *   3. The non-bypassable ID-scan gate: `DRIVER_DELIVERED` is illegal
 *      before the order reaches `id_scan_passed` (XState machine block →
 *      `ORDER_INVALID_TRANSITION`), and even AT `id_scan_passed` the
 *      repository's `COMPLIANCE_ID_SCAN_REQUIRED` gate refuses delivery
 *      unless `delivery_id_scan_passed = true` is already on the row
 *      (defense in depth, only reachable by an out-of-band write — which
 *      this test constructs directly).
 *
 * The vendor / system / id-scan transitions are driven through
 * `OrderTransitionService` directly — the same singleton the HTTP
 * controllers resolve — because the subject here is the state machine +
 * listener wiring, not each controller's plumbing. The order is seeded
 * straight into `placed` via raw SQL (the established `idor-driver`
 * pattern): a real checkout would re-run the sale-hours compliance check,
 * which is irrelevant to the lifecycle wiring under test and is already
 * covered exhaustively by `checkout.flow.test.ts`.
 */
import { stableUuid } from '@dankdash/db';
import { OrderError } from '@dankdash/orders';
import { ConflictError } from '@dankdash/types';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OrderTransitionService } from '../../src/modules/orders/order-transition.service.js';
import { buildTestApp } from '../helpers/build-app.js';
import { SEED_IDS, bearer, getPool, seedFixtures, signTokenFor } from './setup.js';

const DRIVER_USER_ID = stableUuid('user', 'driver-1');

const DROPOFF_SNAPSHOT = {
  line1: '123 Main St',
  line2: null,
  city: 'Minneapolis',
  region: 'MN',
  postalCode: '55401',
  location: { type: 'Point', coordinates: [-93.265, 44.978] },
  deliveryInstructions: null,
};

/** A device location fix that satisfies `DriverLocationFixSchema`. */
function locationFix(): {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  capturedAt: string;
} {
  return {
    latitude: 44.978,
    longitude: -93.265,
    accuracyMeters: 8,
    capturedAt: new Date().toISOString(),
  };
}

interface OrderDetailBody {
  readonly order: { readonly id: string; readonly status: string };
}

describe('order lifecycle — placed → delivered (auto-dispatch, dropoff legs, ID-scan gate)', () => {
  let app: NestFastifyApplication;
  let transitions: OrderTransitionService;

  beforeAll(async () => {
    app = await buildTestApp();
    transitions = app.get(OrderTransitionService);
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seedFixtures();
  });

  it('walks the full happy path; auto-dispatch fires on ready, dropoff endpoints advance, delivery is ID-scan gated', async () => {
    const orderId = await seedPlacedOrder({ shortCode: 'LIFE01' });

    // placed → accepted → prepping → ready_for_pickup, all vendor-driven.
    const vendor = { role: 'vendor' as const, dispensaryId: SEED_IDS.dispensary.mpls };
    await transitions.transition({ orderId, event: 'VENDOR_ACCEPT', actor: vendor });
    expect(await statusOf(orderId)).toBe('accepted');

    await transitions.transition({ orderId, event: 'VENDOR_PREPPING', actor: vendor });
    expect(await statusOf(orderId)).toBe('prepping');

    await transitions.transition({ orderId, event: 'VENDOR_READY', actor: vendor });

    // Gap #1: nothing else fires DISPATCH_QUEUE. The auto-dispatch listener
    // reacts to the post-commit OrderTransitionedEvent and advances the
    // order to awaiting_driver on its own. The hop is async, so poll.
    await waitForStatus(orderId, 'awaiting_driver');

    // Dispatch assigns a driver (system actor; driverId lands via patch).
    await transitions.transition({
      orderId,
      event: 'DRIVER_ASSIGNED',
      actor: { role: 'system' },
      patch: { driverId: DRIVER_USER_ID },
    });
    expect(await statusOf(orderId)).toBe('driver_assigned');
    expect(await driverIdOf(orderId)).toBe(DRIVER_USER_ID);

    const driver = { userId: DRIVER_USER_ID, role: 'driver' as const };
    await transitions.transition({ orderId, event: 'DRIVER_EN_ROUTE_PICKUP', actor: driver });
    expect(await statusOf(orderId)).toBe('en_route_pickup');

    // DRIVER_PICKED_UP is the vendor-handoff hop in production; the auth
    // matrix scopes it to the assigned driver, so fire it as that driver.
    await transitions.transition({ orderId, event: 'DRIVER_PICKED_UP', actor: driver });
    expect(await statusOf(orderId)).toBe('picked_up');

    // Gap #2: the two NEW driver endpoints, over real HTTP.
    const token = signTokenFor(app, { userId: DRIVER_USER_ID, role: 'driver' });

    const depart = await app.inject({
      method: 'POST',
      url: `/v1/driver/orders/${orderId}/depart`,
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { location: locationFix() },
    });
    expect(depart.statusCode, depart.body).toBe(201);
    expect(depart.json<OrderDetailBody>().order.status).toBe('en_route_dropoff');
    expect(await statusOf(orderId)).toBe('en_route_dropoff');

    const arrive = await app.inject({
      method: 'POST',
      url: `/v1/driver/orders/${orderId}/arrive`,
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { location: locationFix() },
    });
    expect(arrive.statusCode, arrive.body).toBe(201);
    expect(arrive.json<OrderDetailBody>().order.status).toBe('arrived_at_dropoff');
    expect(await statusOf(orderId)).toBe('arrived_at_dropoff');

    // The machine forbids delivery before the scan passes: from
    // arrived_at_dropoff the only legal edge is DRIVER_ID_SCAN_STARTED, so
    // DRIVER_DELIVERED is an invalid transition (422), not a compliance
    // refusal yet — it never reaches the repo gate.
    await expect(
      transitions.transition({ orderId, event: 'DRIVER_DELIVERED', actor: driver }),
    ).rejects.toMatchObject({ code: 'ORDER_INVALID_TRANSITION', statusCode: 422 });
    expect(await statusOf(orderId)).toBe('arrived_at_dropoff');

    // Run the mandatory ID scan. ID_SCAN_PASSED is a system event (Veriff
    // is the truth source) and carries the same patch the real
    // DriverIdScanService writes on an approved decision — the passed flag
    // is what later satisfies the repo's delivery gate.
    await transitions.transition({
      orderId,
      event: 'DRIVER_ID_SCAN_STARTED',
      actor: driver,
      payload: { verificationId: 'veriff-sandbox-session' },
      patch: { deliveryIdScanRef: 'veriff-sandbox-session' },
    });
    expect(await statusOf(orderId)).toBe('id_scan_pending');

    await transitions.transition({
      orderId,
      event: 'ID_SCAN_PASSED',
      actor: { role: 'system' },
      patch: {
        deliveryIdScanPassed: true,
        deliveryIdScanAt: new Date(),
        deliveryIdScanRef: 'veriff-sandbox-session',
      },
    });
    expect(await statusOf(orderId)).toBe('id_scan_passed');

    // Now delivery is legal AND the compliance gate is satisfied.
    await transitions.transition({ orderId, event: 'DRIVER_DELIVERED', actor: driver });
    expect(await statusOf(orderId)).toBe('delivered');
    expect(await deliveredAtOf(orderId)).not.toBeNull();

    // The append-only history records the whole walk in order.
    const history = await statusHistory(orderId);
    expect(history).toEqual([
      'accepted',
      'prepping',
      'ready_for_pickup',
      'awaiting_driver',
      'driver_assigned',
      'en_route_pickup',
      'picked_up',
      'en_route_dropoff',
      'arrived_at_dropoff',
      'id_scan_pending',
      'id_scan_passed',
      'delivered',
    ]);
  });

  it('repo ID-scan gate refuses DRIVER_DELIVERED at id_scan_passed when delivery_id_scan_passed is false', async () => {
    // Construct the out-of-band scenario the gate defends against: an order
    // sitting at id_scan_passed WITHOUT the passed flag (production never
    // produces this — ID_SCAN_PASSED always patches the flag true — but a
    // caller bypassing the service layer could). The repo gate is the last
    // line: COMPLIANCE_ID_SCAN_REQUIRED, even though the state machine
    // would allow id_scan_passed → delivered.
    const orderId = await seedPlacedOrder({
      shortCode: 'GATE01',
      status: 'id_scan_passed',
      driverId: DRIVER_USER_ID,
      deliveryIdScanPassed: false,
    });

    const promise = transitions.transition({
      orderId,
      event: 'DRIVER_DELIVERED',
      actor: { userId: DRIVER_USER_ID, role: 'driver' },
    });

    await expect(promise).rejects.toBeInstanceOf(ConflictError);
    await expect(promise).rejects.toMatchObject({
      code: 'COMPLIANCE_ID_SCAN_REQUIRED',
      statusCode: 409,
    });
    // The refused transition rolled back — status is unchanged, no
    // delivered timestamp, no spurious history row.
    expect(await statusOf(orderId)).toBe('id_scan_passed');
    expect(await deliveredAtOf(orderId)).toBeNull();
    expect(await statusHistory(orderId)).toEqual([]);

    // Flipping the flag true (what an approved Veriff decision does) lets
    // the very same transition through — proving the gate keys on the flag,
    // not the state.
    await getPool().sql.unsafe(
      `UPDATE orders SET delivery_id_scan_passed = true WHERE id = $1::uuid`,
      [orderId],
    );
    await transitions.transition({
      orderId,
      event: 'DRIVER_DELIVERED',
      actor: { userId: DRIVER_USER_ID, role: 'driver' },
    });
    expect(await statusOf(orderId)).toBe('delivered');
  });

  it('a terminal-state OrderError surfaces, not a silent no-op, when delivering an already-delivered order', async () => {
    // Once delivered, the only legal edge is DISPUTE_OPENED. A repeat
    // DRIVER_DELIVERED must fail loudly so a double-tap can never
    // re-stamp delivered_at or append a duplicate history row.
    const orderId = await seedPlacedOrder({
      shortCode: 'TERM01',
      status: 'delivered',
      driverId: DRIVER_USER_ID,
      deliveryIdScanPassed: true,
    });

    await expect(
      transitions.transition({
        orderId,
        event: 'DRIVER_DELIVERED',
        actor: { userId: DRIVER_USER_ID, role: 'driver' },
      }),
    ).rejects.toBeInstanceOf(OrderError);
    expect(await statusHistory(orderId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Helpers — small and explicit; no abstraction hiding what the test does.
// ---------------------------------------------------------------------------

interface SeedOrderInput {
  readonly shortCode: string;
  readonly status?: string;
  readonly driverId?: string;
  readonly deliveryIdScanPassed?: boolean;
}

/**
 * Inserts a single order owned by the seeded customer-1 against the MPLS
 * dispensary, with a valid dropoff snapshot so the driver hydrate path
 * (depart/arrive responses) projects cleanly. Money fields satisfy the
 * orders total CHECK: total = subtotal + cannabis_tax + sales_tax +
 * delivery_fee + driver_tip − discount.
 */
async function seedPlacedOrder(input: SeedOrderInput): Promise<string> {
  const pool = getPool();
  const orderId = stableUuid('order', `lifecycle-${input.shortCode}`);
  const [address] = await pool.sql.unsafe<{ id: string }[]>(
    `SELECT id FROM user_addresses WHERE user_id = $1 LIMIT 1`,
    [SEED_IDS.user.customer1],
  );
  await pool.sql.unsafe(
    `INSERT INTO orders (id, short_code, user_id, dispensary_id, driver_id,
                         delivery_address_id, status,
                         subtotal_cents, cannabis_tax_cents, sales_tax_cents,
                         delivery_fee_cents, driver_tip_cents, total_cents,
                         delivery_id_scan_passed,
                         compliance_check_payload, delivery_address_snapshot)
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
             $6::uuid, $7,
             1000, 100, 87,
             599, 0, 1786,
             $8,
             '{}'::jsonb, $9::jsonb)`,
    [
      orderId,
      input.shortCode,
      SEED_IDS.user.customer1,
      SEED_IDS.dispensary.mpls,
      input.driverId ?? null,
      address!.id,
      input.status ?? 'placed',
      input.deliveryIdScanPassed ?? null,
      JSON.stringify(DROPOFF_SNAPSHOT),
    ],
  );
  return orderId;
}

async function statusOf(orderId: string): Promise<string> {
  const rows = await getPool().sql.unsafe<{ status: string }[]>(
    `SELECT status FROM orders WHERE id = $1::uuid`,
    [orderId],
  );
  return rows[0]!.status;
}

async function driverIdOf(orderId: string): Promise<string | null> {
  const rows = await getPool().sql.unsafe<{ driver_id: string | null }[]>(
    `SELECT driver_id FROM orders WHERE id = $1::uuid`,
    [orderId],
  );
  return rows[0]!.driver_id;
}

async function deliveredAtOf(orderId: string): Promise<string | null> {
  const rows = await getPool().sql.unsafe<{ delivered_at: string | null }[]>(
    `SELECT delivered_at FROM orders WHERE id = $1::uuid`,
    [orderId],
  );
  return rows[0]!.delivered_at;
}

async function statusHistory(orderId: string): Promise<readonly string[]> {
  const rows = await getPool().sql.unsafe<{ to_status: string }[]>(
    `SELECT to_status FROM order_status_history WHERE order_id = $1::uuid ORDER BY changed_at`,
    [orderId],
  );
  return rows.map((r) => r.to_status);
}

/**
 * Polls the order row until it reaches `target` or the budget elapses.
 * Used for the auto-dispatch hop, which lands via an async post-commit
 * event listener rather than inline. Real timers run (the suite does not
 * fake the clock), so `setTimeout` advances normally.
 */
async function waitForStatus(orderId: string, target: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = await statusOf(orderId);
    if (last === target) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`order ${orderId} never reached ${target} (last seen: ${last})`);
}
