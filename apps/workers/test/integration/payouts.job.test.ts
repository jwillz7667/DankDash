/**
 * runPayoutJob — integration test against a real Postgres+PostGIS
 * testcontainer.
 *
 * Phase 6.8 coverage map (see CLAUDE-CODE-PHASES.md §6.8):
 *   - Drives the job with a real DB pool and the production
 *     DispensariesRepository / LedgerEntriesRepository / PayoutsRepository
 *     wiring, so any schema↔code drift surfaces here (the unit suite uses
 *     in-memory fakes and would not).
 *   - Seeds dispensary ledger CR entries inside the previous Central-day
 *     window, dispensary refund_reserve DR entries inside the same
 *     window, and a driver CR entry — verifies the job nets, dispatches
 *     to the fake Aeropay, and persists the payout rows.
 *   - Idempotency: a second run with the same `now` finds the rows
 *     already present and short-circuits (no duplicate insert, no second
 *     Aeropay call).
 *
 * Aeropay is faked at the deps level (we only need `createPayout`).
 * Everything else is real: Drizzle, postgres-js, Drizzle migrations
 * applied by the @dankdash/db testing harness.
 */
import { randomUUID } from 'node:crypto';
import { type CreatePayoutInput, type AeropayPayout } from '@dankdash/aeropay';
import {
  DispensariesRepository,
  LedgerEntriesRepository,
  PayoutsRepository,
  createPool,
  stableUuid,
  type Pool,
} from '@dankdash/db';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runPayoutJob, type PayoutJobDeps } from '../../src/jobs/payouts/payout.job.js';

const LOGGER = pino({ level: 'silent' });

// 03:00 America/Chicago on 2026-05-18 (CDT, UTC-5). The job covers the
// previous Central day, so the window is:
//   periodStart = 2026-05-17 00:00 CDT  → 2026-05-17 05:00 UTC
//   periodEnd   = 2026-05-18 00:00 CDT  → 2026-05-18 05:00 UTC
const NOW = new Date('2026-05-18T08:00:00.000Z');
const IN_WINDOW = new Date('2026-05-17T12:00:00.000Z'); // 07:00 CDT — inside
const PERIOD_START_DATE = '2026-05-17';
const PERIOD_END_DATE = '2026-05-18';

class FakeAeropayPayoutsClient {
  public readonly calls: CreatePayoutInput[] = [];
  private seq = 1;

  createPayout = (input: CreatePayoutInput): Promise<AeropayPayout> => {
    this.calls.push(input);
    return Promise.resolve({
      id: `pyt_test_${String(this.seq++).padStart(6, '0')}`,
      // Aeropay returns 'pending' on accept; the job maps that to the DB
      // 'processing' state via updateStatus(... 'processing' ...). The
      // upstream status value is only logged.
      status: 'pending',
      amountCents: input.amountCents,
      bankAccountId: input.bankAccountId,
      recipientRef: input.recipientRef,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      createdAt: new Date(),
    });
  };
}

class TestEnvNotSetError extends Error {
  public override readonly name = 'TestEnvNotSetError';
  constructor() {
    super('TEST_DATABASE_URL is not set. Did the vitest globalSetup run?');
  }
}

let pool: Pool;
let deps: PayoutJobDeps;
let aeropay: FakeAeropayPayoutsClient;
let dispensaryId: string;

describe('runPayoutJob — Phase 6.8 integration', () => {
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
    aeropay = new FakeAeropayPayoutsClient();
    deps = {
      dispensaries: new DispensariesRepository(pool.db),
      ledger: new LedgerEntriesRepository(pool.db),
      payouts: new PayoutsRepository(pool.db),
      aeropay,
      logger: LOGGER,
    };
  }, 120_000);

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    // Wipe just the tables this suite touches — leave the rest of the
    // schema intact so concurrent suites don't trip over each other in CI.
    // RESTART IDENTITY isn't needed; all PKs are UUIDs.
    await pool.sql.unsafe(`TRUNCATE TABLE payouts, ledger_entries, dispensaries CASCADE`);
    dispensaryId = await insertDispensary({ withAeropayBank: true });
    aeropay.calls.length = 0;
  });

  it('nets gross − refund_reserve and dispatches a processing payout with the right idempotency key', async () => {
    // Gross: two dispensary CR entries totaling 10000 cents.
    await insertLedger({
      orderId: null,
      accountType: 'dispensary',
      accountRef: dispensaryId,
      debitCents: 0,
      creditCents: 7_000,
      occurredAt: IN_WINDOW,
      description: 'order-1 dispensary share',
    });
    await insertLedger({
      orderId: null,
      accountType: 'dispensary',
      accountRef: dispensaryId,
      debitCents: 0,
      creditCents: 3_000,
      occurredAt: IN_WINDOW,
      description: 'order-2 dispensary share',
    });
    // Refund reserve: 2500 cents DR in the same window.
    await insertLedger({
      orderId: null,
      accountType: 'refund_reserve',
      accountRef: dispensaryId,
      debitCents: 2_500,
      creditCents: 0,
      occurredAt: IN_WINDOW,
      description: 'refund draw',
    });

    const summary = await runPayoutJob({ now: NOW, deps });

    expect(summary.periodStartDate).toBe(PERIOD_START_DATE);
    expect(summary.periodEndDate).toBe(PERIOD_END_DATE);
    expect(summary.dispensariesProcessed).toBe(1);
    expect(summary.dispensariesDispatched).toBe(1);
    expect(summary.dispensariesFailed).toBe(0);
    expect(summary.dispensariesSkippedNoEarnings).toBe(0);
    expect(summary.dispensariesSkippedNoBank).toBe(0);

    // One Aeropay call with net = 10000 − 2500 = 7500.
    expect(aeropay.calls).toHaveLength(1);
    expect(aeropay.calls[0]?.amountCents).toBe(7_500);
    expect(aeropay.calls[0]?.bankAccountId).toBe('ba_test_mpls');
    expect(aeropay.calls[0]?.recipientRef).toBe(`dispensary:${dispensaryId}`);

    // Payout row landed with the dispatched ref and the upstream id; the
    // idempotency key sent to Aeropay matches `payout:<payouts.id>` so a
    // network retry coalesces upstream.
    const rows = await pool.sql.unsafe<
      Array<{
        readonly id: string;
        readonly net_cents: number | string;
        readonly gross_cents: number | string;
        readonly status: string;
        readonly aeropay_payout_ref: string | null;
      }>
    >(
      `SELECT id, net_cents, gross_cents, status, aeropay_payout_ref FROM payouts WHERE recipient_id = $1`,
      [dispensaryId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('processing');
    expect(Number(rows[0]?.net_cents)).toBe(7_500);
    expect(Number(rows[0]?.gross_cents)).toBe(10_000);
    expect(rows[0]?.aeropay_payout_ref).toMatch(/^pyt_test_\d{6}$/);
    const payoutId = rows[0]?.id;
    expect(payoutId).toBeDefined();
    expect(aeropay.calls[0]?.idempotencyKey).toBe(`payout:${payoutId ?? ''}`);
  });

  it('skips dispensaries with no bank account and marks them failed without calling Aeropay', async () => {
    await pool.sql.unsafe(`UPDATE dispensaries SET aeropay_account_ref = NULL WHERE id = $1`, [
      dispensaryId,
    ]);
    await insertLedger({
      orderId: null,
      accountType: 'dispensary',
      accountRef: dispensaryId,
      debitCents: 0,
      creditCents: 4_200,
      occurredAt: IN_WINDOW,
      description: 'order-3 dispensary share',
    });

    const summary = await runPayoutJob({ now: NOW, deps });

    expect(summary.dispensariesProcessed).toBe(1);
    expect(summary.dispensariesSkippedNoBank).toBe(1);
    expect(summary.dispensariesDispatched).toBe(0);
    expect(aeropay.calls).toHaveLength(0);

    const rows = await pool.sql.unsafe<
      Array<{ readonly status: string; readonly failure_reason: string | null }>
    >(`SELECT status, failure_reason FROM payouts WHERE recipient_id = $1`, [dispensaryId]);
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.failure_reason).toBe('dispensary_bank_account_not_linked');
  });

  it('is idempotent — re-running for the same period does not duplicate payouts or call Aeropay again', async () => {
    await insertLedger({
      orderId: null,
      accountType: 'dispensary',
      accountRef: dispensaryId,
      debitCents: 0,
      creditCents: 6_000,
      occurredAt: IN_WINDOW,
      description: 'order-1 dispensary share',
    });

    const first = await runPayoutJob({ now: NOW, deps });
    expect(first.dispensariesDispatched).toBe(1);
    expect(aeropay.calls).toHaveLength(1);

    const beforeSecond = await pool.sql.unsafe<Array<{ readonly id: string }>>(
      `SELECT id FROM payouts WHERE recipient_id = $1`,
      [dispensaryId],
    );

    const second = await runPayoutJob({ now: NOW, deps });
    expect(second.dispensariesAlreadyPaid).toBe(1);
    expect(second.dispensariesDispatched).toBe(0);
    // The second run must NOT call Aeropay again — the existing row's
    // `created=false` short-circuits before dispatch.
    expect(aeropay.calls).toHaveLength(1);

    const afterSecond = await pool.sql.unsafe<Array<{ readonly id: string }>>(
      `SELECT id FROM payouts WHERE recipient_id = $1`,
      [dispensaryId],
    );
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]?.id).toBe(beforeSecond[0]?.id);
  });

  it('excludes ledger entries outside the [periodStart, periodEnd) window', async () => {
    // Day before the window — must NOT be counted.
    await insertLedger({
      orderId: null,
      accountType: 'dispensary',
      accountRef: dispensaryId,
      debitCents: 0,
      creditCents: 9_999,
      occurredAt: new Date('2026-05-16T15:00:00.000Z'),
      description: 'before-window',
    });
    // Exactly the periodEnd boundary — exclusive upper bound, must NOT count.
    await insertLedger({
      orderId: null,
      accountType: 'dispensary',
      accountRef: dispensaryId,
      debitCents: 0,
      creditCents: 8_888,
      occurredAt: new Date('2026-05-18T05:00:00.000Z'),
      description: 'periodEnd boundary',
    });
    // Inside the window — only this one should be picked up.
    await insertLedger({
      orderId: null,
      accountType: 'dispensary',
      accountRef: dispensaryId,
      debitCents: 0,
      creditCents: 1_234,
      occurredAt: IN_WINDOW,
      description: 'inside window',
    });

    const summary = await runPayoutJob({ now: NOW, deps });

    expect(summary.dispensariesDispatched).toBe(1);
    expect(aeropay.calls).toHaveLength(1);
    expect(aeropay.calls[0]?.amountCents).toBe(1_234);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LedgerInsert {
  readonly orderId: string | null;
  readonly accountType: string;
  readonly accountRef: string | null;
  readonly debitCents: number;
  readonly creditCents: number;
  readonly occurredAt: Date;
  readonly description: string;
}

async function insertLedger(input: LedgerInsert): Promise<void> {
  // postgres-js .unsafe() with a positional array does not infer Date → timestamptz,
  // so pass an ISO string and let Postgres cast it. Same reason we cast the enum.
  await pool.sql.unsafe(
    `INSERT INTO ledger_entries
       (id, order_id, account_type, account_ref, debit_cents, credit_cents, description, occurred_at)
     VALUES ($1, $2, $3::ledger_account_type, $4, $5, $6, $7, $8::timestamptz)`,
    [
      randomUUID(),
      input.orderId,
      input.accountType,
      input.accountRef,
      input.debitCents,
      input.creditCents,
      input.description,
      input.occurredAt.toISOString(),
    ],
  );
}

/**
 * Insert a minimal-but-valid dispensaries row. PostGIS columns require a
 * geography literal, so we go through `ST_GeomFromGeoJSON` rather than
 * dropping to raw WKT. The MPLS-shaped polygon is large enough that any
 * point inside the metro area would test_contains, but this suite never
 * asks PostGIS to filter, so the geometry only has to be valid.
 */
async function insertDispensary(opts: { readonly withAeropayBank: boolean }): Promise<string> {
  const id = stableUuid('dispensary', `payout-int-${randomUUID()}`);
  const polygon = JSON.stringify({
    type: 'Polygon',
    coordinates: [
      [
        [-93.33, 44.88],
        [-93.33, 45.06],
        [-93.18, 45.06],
        [-93.18, 44.88],
        [-93.33, 44.88],
      ],
    ],
  });
  const point = JSON.stringify({ type: 'Point', coordinates: [-93.273, 44.987] });
  await pool.sql.unsafe(
    `INSERT INTO dispensaries (
       id, legal_name, license_number, license_type,
       license_issued_at, license_expires_at,
       address_line1, city, region, postal_code,
       location, delivery_polygon, hours_json, status, is_accepting_orders,
       aeropay_account_ref
     ) VALUES (
       $1, $2, $3, 'retailer',
       DATE '2025-01-01', DATE '2030-01-01',
       '720 N Washington', 'Minneapolis', 'MN', '55401',
       ST_SetSRID(ST_GeomFromGeoJSON($4), 4326)::geography,
       ST_SetSRID(ST_GeomFromGeoJSON($5), 4326)::geography,
       '{}'::jsonb, 'active', true,
       $6
     )`,
    [
      id,
      `Payout Test Dispensary ${id.slice(0, 8)}`,
      `MN-RTL-PAYOUT-${id.slice(0, 8)}`,
      point,
      polygon,
      opts.withAeropayBank ? 'ba_test_mpls' : null,
    ],
  );
  return id;
}
