/**
 * runPayoutReconciliationJob — integration test against a real
 * Postgres+PostGIS testcontainer.
 *
 * Drives the reconciliation cron through the production PayoutsRepository so
 * the new `listStuckProcessing` query and the terminal `updateStatus` path
 * are exercised against the real `payouts` schema (the unit suite uses
 * in-memory fakes and would not catch column/enum drift). Aeropay's payout
 * read is faked at the deps level (`getPayout` only) — a paid/failed/404
 * per ref lets us cover every terminal branch plus window exclusion and
 * idempotency.
 */
import { randomUUID } from 'node:crypto';
import { type AeropayPayout } from '@dankdash/aeropay';
import { PayoutsRepository, createPool, stableUuid, type Pool } from '@dankdash/db';
import { PaymentError } from '@dankdash/types';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  runPayoutReconciliationJob,
  type PayoutReconciliationJobDeps,
} from '../../src/jobs/payout-reconciliation/payout-reconciliation.job.js';

const LOGGER = pino({ level: 'silent' });

const NOW = new Date('2026-06-01T12:00:00.000Z');
// 2h before NOW — past the 15m stuck threshold, within the 24h orphan grace.
const STUCK_INITIATED = new Date('2026-06-01T10:00:00.000Z');
// 5m before NOW — inside the stuck grace, must not be reconciled.
const RECENT_INITIATED = new Date('2026-06-01T11:55:00.000Z');
// 2 days before NOW — past the 24h orphan threshold.
const ORPHAN_INITIATED = new Date('2026-05-30T12:00:00.000Z');

class FakeAeropayReadClient {
  readonly calls: string[] = [];
  readonly responses = new Map<string, AeropayPayout>();
  readonly notFound = new Set<string>();

  getPayout = (id: string): Promise<AeropayPayout> => {
    this.calls.push(id);
    if (this.notFound.has(id)) {
      return Promise.reject(new PaymentError('PAYMENT_METHOD_INVALID', 'not found', {}, 404));
    }
    const hit = this.responses.get(id);
    if (hit !== undefined) return Promise.resolve(hit);
    return Promise.reject(new PaymentError('PAYMENT_PROVIDER_UNAVAILABLE', 'unexpected', {}, 502));
  };
}

class TestEnvNotSetError extends Error {
  public override readonly name = 'TestEnvNotSetError';
  constructor() {
    super('TEST_DATABASE_URL is not set. Did the vitest globalSetup run?');
  }
}

let pool: Pool;
let payouts: PayoutsRepository;
let aeropay: FakeAeropayReadClient;
let deps: PayoutReconciliationJobDeps;

describe('runPayoutReconciliationJob — integration', () => {
  beforeAll(() => {
    const url = process.env['TEST_DATABASE_URL'];
    if (url === undefined || url.length === 0) throw new TestEnvNotSetError();
    pool = createPool({
      databaseUrl: url,
      logger: LOGGER,
      maxConnections: 4,
      prepare: false,
      slowQueryThresholdMs: 10_000,
    });
    payouts = new PayoutsRepository(pool.db);
  }, 120_000);

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await pool.sql.unsafe(`TRUNCATE TABLE payouts CASCADE`);
    aeropay = new FakeAeropayReadClient();
    deps = { payouts, aeropay, logger: LOGGER };
  });

  it('completes a stuck processing payout Aeropay reports as paid', async () => {
    const ref = 'po_paid_1';
    const id = await insertProcessingPayout({
      aeropayPayoutRef: ref,
      initiatedAt: STUCK_INITIATED,
    });
    aeropay.responses.set(ref, upstream(ref, 'paid'));

    const summary = await runPayoutReconciliationJob({ now: NOW, deps });

    expect(summary).toMatchObject({ scanned: 1, completed: 1 });
    const row = await selectPayout(id);
    expect(row?.status).toBe('completed');
    expect(row?.completed_at).not.toBeNull();
  });

  it('fails a stuck payout Aeropay reports as failed', async () => {
    const ref = 'po_failed_1';
    const id = await insertProcessingPayout({
      aeropayPayoutRef: ref,
      initiatedAt: STUCK_INITIATED,
    });
    aeropay.responses.set(ref, upstream(ref, 'failed'));

    const summary = await runPayoutReconciliationJob({ now: NOW, deps });

    expect(summary).toMatchObject({ scanned: 1, failed: 1 });
    const row = await selectPayout(id);
    expect(row?.status).toBe('failed');
    expect(row?.failure_reason).toBe('reconciliation_failed');
  });

  it('orphans a stuck payout Aeropay does not recognize past the orphan age', async () => {
    const ref = 'po_orphan_1';
    const id = await insertProcessingPayout({
      aeropayPayoutRef: ref,
      initiatedAt: ORPHAN_INITIATED,
    });
    aeropay.notFound.add(ref);

    const summary = await runPayoutReconciliationJob({ now: NOW, deps });

    expect(summary).toMatchObject({ scanned: 1, orphaned: 1 });
    const row = await selectPayout(id);
    expect(row?.status).toBe('failed');
    expect(row?.failure_reason).toBe('reconciliation_orphan');
  });

  it('leaves a payout still in flight (pending) untouched', async () => {
    const ref = 'po_pending_1';
    const id = await insertProcessingPayout({
      aeropayPayoutRef: ref,
      initiatedAt: STUCK_INITIATED,
    });
    aeropay.responses.set(ref, upstream(ref, 'in_transit'));

    const summary = await runPayoutReconciliationJob({ now: NOW, deps });

    expect(summary).toMatchObject({ scanned: 1, stillPending: 1 });
    const row = await selectPayout(id);
    expect(row?.status).toBe('processing');
  });

  it('does not touch a payout still inside the stuck grace window', async () => {
    const ref = 'po_recent_1';
    const id = await insertProcessingPayout({
      aeropayPayoutRef: ref,
      initiatedAt: RECENT_INITIATED,
    });
    aeropay.responses.set(ref, upstream(ref, 'paid'));

    const summary = await runPayoutReconciliationJob({ now: NOW, deps });

    expect(summary.scanned).toBe(0);
    expect(aeropay.calls).toHaveLength(0);
    const row = await selectPayout(id);
    expect(row?.status).toBe('processing');
  });

  it('is idempotent — a completed row is no longer stuck and a second run is a no-op', async () => {
    const ref = 'po_idem_1';
    await insertProcessingPayout({ aeropayPayoutRef: ref, initiatedAt: STUCK_INITIATED });
    aeropay.responses.set(ref, upstream(ref, 'paid'));

    const first = await runPayoutReconciliationJob({ now: NOW, deps });
    expect(first.completed).toBe(1);

    const second = await runPayoutReconciliationJob({ now: NOW, deps });
    expect(second.scanned).toBe(0);
    // Only the first run read from Aeropay; the completed row drops out of
    // the stuck-processing query.
    expect(aeropay.calls).toEqual([ref]);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function upstream(id: string, status: AeropayPayout['status']): AeropayPayout {
  return {
    id,
    status,
    amountCents: 12_500,
    bankAccountId: 'ba_test',
    recipientRef: 'dispensary:x',
    periodStart: new Date('2026-05-29T00:00:00.000Z'),
    periodEnd: new Date('2026-05-30T00:00:00.000Z'),
    createdAt: STUCK_INITIATED,
  };
}

async function insertProcessingPayout(input: {
  readonly aeropayPayoutRef: string;
  readonly initiatedAt: Date;
}): Promise<string> {
  const id = stableUuid('payout', `recon-int-${randomUUID()}`);
  await pool.sql.unsafe(
    `INSERT INTO payouts (
       id, recipient_type, recipient_id, period_start, period_end,
       gross_cents, fees_cents, net_cents, aeropay_payout_ref, status,
       scheduled_for, initiated_at
     ) VALUES (
       $1, 'dispensary', $2, DATE '2026-05-29', DATE '2026-05-30',
       12500, 0, 12500, $3, 'processing',
       DATE '2026-05-30', $4::timestamptz
     )`,
    [id, randomUUID(), input.aeropayPayoutRef, input.initiatedAt.toISOString()],
  );
  return id;
}

async function selectPayout(id: string): Promise<
  | {
      readonly status: string;
      readonly failure_reason: string | null;
      readonly completed_at: string | null;
    }
  | undefined
> {
  const rows = await pool.sql.unsafe<
    Array<{
      readonly status: string;
      readonly failure_reason: string | null;
      readonly completed_at: string | null;
    }>
  >(`SELECT status, failure_reason, completed_at FROM payouts WHERE id = $1`, [id]);
  return rows[0];
}
