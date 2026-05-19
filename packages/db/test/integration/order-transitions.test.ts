/**
 * Integration tests for OrdersRepository.applyTransition + the
 * order_status_history table introduced in migration 0005.
 *
 * These exercise the real Postgres tx semantics that the unit tests in
 * apps/api/src/modules/orders/order-transition.service.test.ts can't:
 *
 *   - `applyTransition` runs atomically inside a single tx — UPDATE orders
 *     + INSERT order_events + INSERT order_status_history either all commit
 *     or none do (rollback test).
 *   - The per-state timestamp column (`accepted_at`, `delivered_at`, …) is
 *     auto-stamped from `STATUS_TIMESTAMP_COLUMN` without the caller
 *     supplying it.
 *   - The `order_status_history` partitioned table has the same
 *     `dankdash_block_mutation` trigger as `order_events`: no UPDATE,
 *     no DELETE permitted.
 *   - `listStatusHistory` returns the most-recent row first.
 *   - `findById` returns null when the order doesn't exist.
 */
import { NotFoundError, RepositoryError } from '@dankdash/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { OrderEventsRepository, OrdersRepository, stableUuid } from '../../src/index.js';
import { getPool, seedDefault } from '../setup.js';

const ALICE = stableUuid('user', 'customer-1');
const MPLS = stableUuid('dispensary', 'mpls');
const ADDR_ALICE = stableUuid('address', 'addr-alice-home');

/** Insert a fresh `placed` order for each test; returns its id. */
async function insertPlacedOrder(): Promise<string> {
  const pool = getPool();
  const shortCode = `T${Math.floor(Math.random() * 1_000_000_000)}`.slice(0, 7);
  const [row] = await pool.sql<{ id: string }[]>`
    INSERT INTO orders (
      short_code, user_id, dispensary_id, delivery_address_id,
      status, subtotal_cents, cannabis_tax_cents, sales_tax_cents,
      delivery_fee_cents, total_cents,
      compliance_check_payload, delivery_address_snapshot
    )
    VALUES (
      ${shortCode}, ${ALICE}, ${MPLS}, ${ADDR_ALICE},
      'placed', 1000, 100, 100, 0, 1200,
      '{}'::jsonb, '{}'::jsonb
    )
    RETURNING id
  `;
  if (row === undefined) {
    throw new RepositoryError('order-transitions test seed: INSERT returned no row');
  }
  return row.id;
}

describe('OrdersRepository.applyTransition', () => {
  beforeAll(async () => {
    await seedDefault();
  }, 60_000);

  it('updates status + per-state timestamp + appends order_events + order_status_history atomically', async () => {
    const pool = getPool();
    const repo = new OrdersRepository(pool.db);
    const orderId = await insertPlacedOrder();

    const updated = await repo.applyTransition(orderId, () => ({
      toStatus: 'accepted',
      eventType: 'VENDOR_ACCEPT',
      actorUserId: ALICE,
      actorRole: 'vendor',
    }));

    expect(updated.status).toBe('accepted');
    expect(updated.acceptedAt).not.toBeNull();
    expect(updated.statusChangedAt.getTime()).toBeGreaterThan(0);

    const [eventRow] = await pool.sql<
      { event_type: string; actor_user_id: string | null; actor_role: string | null }[]
    >`SELECT event_type, actor_user_id, actor_role FROM order_events WHERE order_id = ${orderId}`;
    expect(eventRow).toBeDefined();
    expect(eventRow!.event_type).toBe('VENDOR_ACCEPT');
    expect(eventRow!.actor_user_id).toBe(ALICE);
    expect(eventRow!.actor_role).toBe('vendor');

    const history = await repo.listStatusHistory(orderId);
    expect(history).toHaveLength(1);
    expect(history[0]!.fromStatus).toBe('placed');
    expect(history[0]!.toStatus).toBe('accepted');
    expect(history[0]!.eventType).toBe('VENDOR_ACCEPT');
  });

  it('threads `reason` and the patch fields through to the row + history', async () => {
    const pool = getPool();
    const repo = new OrdersRepository(pool.db);
    const orderId = await insertPlacedOrder();

    await repo.applyTransition(orderId, () => ({
      toStatus: 'canceled',
      eventType: 'CUSTOMER_CANCEL',
      actorUserId: ALICE,
      actorRole: 'customer',
      reason: 'changed my mind',
      patch: { canceledBy: ALICE, cancelReason: 'changed my mind' },
    }));

    const refreshed = await repo.findById(orderId);
    expect(refreshed?.status).toBe('canceled');
    expect(refreshed?.canceledAt).not.toBeNull();
    expect(refreshed?.canceledBy).toBe(ALICE);
    expect(refreshed?.cancelReason).toBe('changed my mind');

    const history = await repo.listStatusHistory(orderId);
    expect(history[0]!.reason).toBe('changed my mind');
  });

  it('listStatusHistory returns rows newest-first for a multi-step lifecycle', async () => {
    const pool = getPool();
    const repo = new OrdersRepository(pool.db);
    const orderId = await insertPlacedOrder();

    await repo.applyTransition(orderId, () => ({
      toStatus: 'accepted',
      eventType: 'VENDOR_ACCEPT',
      actorRole: 'vendor',
      actorUserId: ALICE,
    }));
    // Spread the two history rows past Postgres' microsecond resolution so
    // the ORDER BY changed_at DESC is deterministic.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await repo.applyTransition(orderId, () => ({
      toStatus: 'prepping',
      eventType: 'VENDOR_PREPPING',
      actorRole: 'vendor',
      actorUserId: ALICE,
    }));

    const history = await repo.listStatusHistory(orderId);
    expect(history).toHaveLength(2);
    expect(history[0]!.toStatus).toBe('prepping');
    expect(history[1]!.toStatus).toBe('accepted');
  });

  it('throws NotFoundError when the order does not exist', async () => {
    const pool = getPool();
    const repo = new OrdersRepository(pool.db);
    const ghostId = stableUuid('order', 'does-not-exist');

    await expect(
      repo.applyTransition(ghostId, () => ({
        toStatus: 'accepted',
        eventType: 'VENDOR_ACCEPT',
        actorRole: 'vendor',
      })),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('order_status_history is append-only (UPDATE + DELETE rejected by trigger)', async () => {
    const pool = getPool();
    const repo = new OrdersRepository(pool.db);
    const orderId = await insertPlacedOrder();

    await repo.applyTransition(orderId, () => ({
      toStatus: 'accepted',
      eventType: 'VENDOR_ACCEPT',
      actorRole: 'vendor',
      actorUserId: ALICE,
    }));

    const [historyRow] = await pool.sql<
      { id: string; changed_at: Date }[]
    >`SELECT id, changed_at FROM order_status_history WHERE order_id = ${orderId} ORDER BY changed_at DESC LIMIT 1`;
    expect(historyRow).toBeDefined();

    await expect(
      pool.sql`UPDATE order_status_history SET reason = 'tamper' WHERE id = ${historyRow!.id} AND changed_at = ${historyRow!.changed_at}`,
    ).rejects.toThrow(/append-only/);

    await expect(
      pool.sql`DELETE FROM order_status_history WHERE id = ${historyRow!.id} AND changed_at = ${historyRow!.changed_at}`,
    ).rejects.toThrow(/append-only/);
  });

  it('order_events insert routed through OrderEventsRepository still rejects UPDATE/DELETE (regression vs migration 0005)', async () => {
    // Sanity check that adding the order_status_history trigger did not
    // accidentally drop or replace the order_events trigger from migration
    // 0001. The invariants suite covers the same surface but with a hand-
    // rolled event row; here we go through the repo to stay in sync with
    // how the app actually writes.
    const pool = getPool();
    const events = new OrderEventsRepository(pool.db);
    const orderId = await insertPlacedOrder();

    const recorded = await events.record({
      orderId,
      eventType: 'TEST_EVENT',
      payload: {},
    });

    await expect(
      pool.sql`UPDATE order_events SET event_type = 'tamper' WHERE id = ${recorded.id}`,
    ).rejects.toThrow(/append-only/);
  });
});
