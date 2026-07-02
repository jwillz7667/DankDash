/**
 * runPayoutJob unit tests. Exercises every branch of the dispensary +
 * driver paths with in-memory fakes:
 *
 *   - Dispensary path: skip net-zero, skip net-negative-after-refund,
 *     skip no-bank, skip already-paid (idempotent), dispatch happy path,
 *     failed-Aeropay path, missing-dispensary-row path.
 *   - Driver path: skip net-zero, record pending (no linked bank),
 *     dispatch happy path (linked bank), failed-Aeropay path, already-paid
 *     idempotency.
 *   - Refund drawdown math: dispensary gross 10000 − reserve 3000 = 7000
 *     payout.
 *   - End-to-end shape: summary counts match what the fakes saw.
 *
 * The fakes only stub the methods the job actually calls. Each fake
 * surfaces a `calls` array so test assertions can pin order and shape.
 */
import { type AeropayPayout, type CreatePayoutInput } from '@dankdash/aeropay';
import { type Logger } from '@dankdash/config';
import {
  type Dispensary,
  type LedgerAccountType,
  type NewPayout,
  type Payout,
  type PayoutStatus,
} from '@dankdash/db';
import { RepositoryError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { runPayoutJob, type PayoutJobDeps } from './payout.job.js';

const NOW = new Date('2026-05-18T08:00:00.000Z'); // 03:00 CDT
const PERIOD_START_DATE = '2026-05-17';
const PERIOD_END_DATE = '2026-05-18';
const PERIOD_START_UTC = new Date('2026-05-17T05:00:00.000Z');
const PERIOD_END_UTC = new Date('2026-05-18T05:00:00.000Z');

const DISP_A = '01935f3d-0000-7000-8000-0000000000a1';
const DISP_B = '01935f3d-0000-7000-8000-0000000000a2';
const DISP_C_NO_BANK = '01935f3d-0000-7000-8000-0000000000a3';
const DISP_D_GHOST = '01935f3d-0000-7000-8000-0000000000a4';
const DRIVER_1 = '01935f3d-0000-7000-8000-0000000000d1';
const DRIVER_2 = '01935f3d-0000-7000-8000-0000000000d2';

function makeDispensary(overrides: Partial<Dispensary>): Dispensary {
  return {
    id: 'placeholder',
    legalName: 'Test Co LLC',
    dba: null,
    licenseNumber: 'L-0001',
    licenseType: 'retailer',
    licenseIssuedAt: '2026-01-01',
    licenseExpiresAt: '2027-01-01',
    metrcFacilityId: null,
    metrcApiKeyEnc: null,
    posProvider: 'manual',
    posCredentialsEnc: null,
    posLastSyncedAt: null,
    addressLine1: '123 Main St',
    addressLine2: null,
    city: 'Minneapolis',
    region: 'MN',
    postalCode: '55401',
    location: { type: 'Point', coordinates: [-93.265, 44.977] },
    deliveryPolygon: {
      type: 'Polygon',
      coordinates: [
        [
          [-93.3, 44.9],
          [-93.2, 44.9],
          [-93.2, 45.0],
          [-93.3, 45.0],
          [-93.3, 44.9],
        ],
      ],
    },
    hoursJson: {},
    phone: null,
    email: null,
    logoImageKey: null,
    heroImageKey: null,
    brandColorHex: null,
    aeropayAccountRef: 'aeropay_bank_test_1',
    isAcceptingOrders: true,
    ratingAvg: null,
    ratingCount: 0,
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

class FakeDispensariesRepo {
  rows = new Map<string, Dispensary>();
  findByIdCalls: string[] = [];

  add(d: Dispensary): void {
    this.rows.set(d.id, d);
  }

  findById = (id: string): Promise<Dispensary | null> => {
    this.findByIdCalls.push(id);
    return Promise.resolve(this.rows.get(id) ?? null);
  };
}

class FakeDriversRepo {
  // driverUserId → linked aeropay bank ref (null = linked-but-no-ref is
  // impossible; absence from the map means no driver row at all).
  private refs = new Map<string, string | null>();
  findByUserIdCalls: string[] = [];

  /** Register a driver with a linked bank ref. */
  addLinked(driverUserId: string, aeropayAccountRef: string): void {
    this.refs.set(driverUserId, aeropayAccountRef);
  }

  /** Register a driver row that exists but has not linked a bank account. */
  addUnlinked(driverUserId: string): void {
    this.refs.set(driverUserId, null);
  }

  findByUserId = (userId: string): Promise<{ aeropayAccountRef: string | null } | null> => {
    this.findByUserIdCalls.push(userId);
    if (!this.refs.has(userId)) return Promise.resolve(null);
    return Promise.resolve({ aeropayAccountRef: this.refs.get(userId) ?? null });
  };
}

interface LedgerWindowCall {
  readonly accountType: LedgerAccountType;
  readonly periodStartUtc: Date;
  readonly periodEndUtc: Date;
}

class FakeLedgerRepo {
  byType = new Map<
    LedgerAccountType,
    ReadonlyArray<{ readonly accountRef: string; readonly netCents: number }>
  >();
  calls: LedgerWindowCall[] = [];

  set(
    accountType: LedgerAccountType,
    rows: ReadonlyArray<{ readonly accountRef: string; readonly netCents: number }>,
  ): void {
    this.byType.set(accountType, rows);
  }

  netByAccountRefInWindow = (
    accountType: LedgerAccountType,
    periodStartUtc: Date,
    periodEndUtc: Date,
  ): Promise<readonly { readonly accountRef: string; readonly netCents: number }[]> => {
    this.calls.push({ accountType, periodStartUtc, periodEndUtc });
    return Promise.resolve(this.byType.get(accountType) ?? []);
  };
}

interface CreateIfAbsentCall {
  readonly input: Omit<NewPayout, 'id'>;
}

interface UpdateStatusCall {
  readonly id: string;
  readonly status: PayoutStatus;
  readonly patch: Record<string, unknown>;
}

class FakePayoutsRepo {
  rows: Payout[] = [];
  createIfAbsentCalls: CreateIfAbsentCall[] = [];
  updateStatusCalls: UpdateStatusCall[] = [];
  // Recipients here already have a payout row in the table — exercising
  // the idempotency path.
  preExisting = new Set<string>();
  private idSeq = 1;

  private key(
    input: Pick<NewPayout, 'recipientType' | 'recipientId' | 'periodStart' | 'periodEnd'>,
  ): string {
    return `${input.recipientType}:${input.recipientId}:${input.periodStart}:${input.periodEnd}`;
  }

  seedExisting(input: NewPayout): void {
    const row: Payout = {
      id: input.id ?? `existing-${this.idSeq++}`,
      recipientType: input.recipientType,
      recipientId: input.recipientId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      grossCents: input.grossCents,
      feesCents: input.feesCents ?? 0,
      netCents: input.netCents,
      aeropayPayoutRef: input.aeropayPayoutRef ?? null,
      status: input.status ?? 'pending',
      scheduledFor: input.scheduledFor,
      initiatedAt: input.initiatedAt ?? null,
      completedAt: input.completedAt ?? null,
      failureReason: input.failureReason ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.rows.push(row);
    this.preExisting.add(this.key(input));
  }

  createIfAbsent = (
    input: Omit<NewPayout, 'id'> & { readonly id?: string },
  ): Promise<{ readonly payout: Payout; readonly created: boolean }> => {
    this.createIfAbsentCalls.push({ input });
    const k = this.key(input);
    if (this.preExisting.has(k)) {
      const existing = this.rows.find((r) => this.key(r) === k);
      if (existing === undefined) {
        throw new RepositoryError(`fake bookkeeping bug: ${k}`);
      }
      return Promise.resolve({ payout: existing, created: false });
    }
    const payout: Payout = {
      id: input.id ?? `payout-${this.idSeq++}`,
      recipientType: input.recipientType,
      recipientId: input.recipientId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      grossCents: input.grossCents,
      feesCents: input.feesCents ?? 0,
      netCents: input.netCents,
      aeropayPayoutRef: input.aeropayPayoutRef ?? null,
      status: input.status ?? 'pending',
      scheduledFor: input.scheduledFor,
      initiatedAt: input.initiatedAt ?? null,
      completedAt: input.completedAt ?? null,
      failureReason: input.failureReason ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.rows.push(payout);
    this.preExisting.add(k);
    return Promise.resolve({ payout, created: true });
  };

  updateStatus = (
    id: string,
    status: PayoutStatus,
    patch: Record<string, unknown> = {},
  ): Promise<Payout | null> => {
    this.updateStatusCalls.push({ id, status, patch });
    const row = this.rows.find((r) => r.id === id);
    if (row === undefined) return Promise.resolve(null);
    Object.assign(row, { status, ...patch, updatedAt: new Date() });
    return Promise.resolve(row);
  };
}

class FakeAeropayClient {
  createPayoutCalls: CreatePayoutInput[] = [];
  failNext = false;
  failNextWith: Error | null = null;
  private payoutIdSeq = 1;

  createPayout = (input: CreatePayoutInput): Promise<AeropayPayout> => {
    this.createPayoutCalls.push(input);
    if (this.failNext) {
      this.failNext = false;
      const err = this.failNextWith ?? new Error('aeropay sandbox 500');
      this.failNextWith = null;
      return Promise.reject(err);
    }
    return Promise.resolve({
      id: `aeropay_payout_${this.payoutIdSeq++}`,
      status: 'in_transit',
      amountCents: input.amountCents,
      bankAccountId: input.bankAccountId,
      recipientRef: input.recipientRef,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      createdAt: new Date(),
    });
  };
}

function silentLogger(): Logger {
  const noop = (): void => undefined;
  // pino's Logger.child has a generic ChildCustomLevels signature that's
  // painful to satisfy in a stub; tests only need `info|warn|error|child`
  // to be callable. Cast through `unknown` to bypass the constraint —
  // this fake is only used by the job's logger.child(...) calls.
  const stub: Record<string, unknown> = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
  };
  stub['child'] = (): Logger => stub as unknown as Logger;
  return stub as unknown as Logger;
}

function build(): {
  deps: PayoutJobDeps;
  dispensaries: FakeDispensariesRepo;
  drivers: FakeDriversRepo;
  ledger: FakeLedgerRepo;
  payouts: FakePayoutsRepo;
  aeropay: FakeAeropayClient;
} {
  const dispensaries = new FakeDispensariesRepo();
  const drivers = new FakeDriversRepo();
  const ledger = new FakeLedgerRepo();
  const payouts = new FakePayoutsRepo();
  const aeropay = new FakeAeropayClient();
  return {
    deps: {
      dispensaries: dispensaries as unknown as PayoutJobDeps['dispensaries'],
      drivers: drivers as unknown as PayoutJobDeps['drivers'],
      ledger: ledger as unknown as PayoutJobDeps['ledger'],
      payouts: payouts as unknown as PayoutJobDeps['payouts'],
      aeropay,
      logger: silentLogger(),
    },
    dispensaries,
    drivers,
    ledger,
    payouts,
    aeropay,
  };
}

describe('runPayoutJob — dispensary path', () => {
  it('dispatches a clean payout when net earnings are positive and bank is linked', async () => {
    const { deps, dispensaries, ledger, payouts, aeropay } = build();
    dispensaries.add(makeDispensary({ id: DISP_A, aeropayAccountRef: 'bank_A' }));
    ledger.set('dispensary', [{ accountRef: DISP_A, netCents: 12_500 }]);
    ledger.set('refund_reserve', []);

    const summary = await runPayoutJob({ now: NOW, deps });

    expect(summary.dispensariesDispatched).toBe(1);
    expect(summary.dispensariesProcessed).toBe(1);
    expect(payouts.createIfAbsentCalls).toHaveLength(1);
    expect(payouts.createIfAbsentCalls[0]?.input.grossCents).toBe(12_500);
    expect(payouts.createIfAbsentCalls[0]?.input.netCents).toBe(12_500);
    expect(aeropay.createPayoutCalls).toHaveLength(1);
    expect(aeropay.createPayoutCalls[0]?.bankAccountId).toBe('bank_A');
    expect(aeropay.createPayoutCalls[0]?.amountCents).toBe(12_500);
    expect(aeropay.createPayoutCalls[0]?.idempotencyKey).toMatch(/^payout:/);
    expect(payouts.updateStatusCalls).toEqual([
      expect.objectContaining({
        status: 'processing',
        patch: expect.objectContaining({ aeropayPayoutRef: expect.any(String) }),
      }),
    ]);
  });

  it('subtracts refund_reserve drawdowns from gross when computing net', async () => {
    const { deps, dispensaries, ledger, aeropay, payouts } = build();
    dispensaries.add(makeDispensary({ id: DISP_A }));
    ledger.set('dispensary', [{ accountRef: DISP_A, netCents: 10_000 }]);
    // refund_reserve stores debits (refunds DR the reserve). repo returns
    // credits - debits, so a refund of $30 against this dispensary shows
    // up as -3000.
    ledger.set('refund_reserve', [{ accountRef: DISP_A, netCents: -3_000 }]);

    await runPayoutJob({ now: NOW, deps });

    expect(payouts.createIfAbsentCalls[0]?.input.grossCents).toBe(10_000);
    expect(payouts.createIfAbsentCalls[0]?.input.netCents).toBe(7_000);
    expect(aeropay.createPayoutCalls[0]?.amountCents).toBe(7_000);
  });

  it('skips dispensaries whose net is zero or negative after drawdown', async () => {
    const { deps, dispensaries, ledger, payouts, aeropay } = build();
    dispensaries.add(makeDispensary({ id: DISP_A }));
    ledger.set('dispensary', [{ accountRef: DISP_A, netCents: 2_000 }]);
    ledger.set('refund_reserve', [{ accountRef: DISP_A, netCents: -2_500 }]);

    const summary = await runPayoutJob({ now: NOW, deps });

    expect(summary.dispensariesSkippedNoEarnings).toBe(1);
    expect(summary.dispensariesDispatched).toBe(0);
    expect(payouts.createIfAbsentCalls).toHaveLength(0);
    expect(aeropay.createPayoutCalls).toHaveLength(0);
  });

  it('marks payout failed when the dispensary has no Aeropay account linked', async () => {
    const { deps, dispensaries, ledger, payouts, aeropay } = build();
    dispensaries.add(makeDispensary({ id: DISP_C_NO_BANK, aeropayAccountRef: null }));
    ledger.set('dispensary', [{ accountRef: DISP_C_NO_BANK, netCents: 5_000 }]);
    ledger.set('refund_reserve', []);

    const summary = await runPayoutJob({ now: NOW, deps });

    expect(summary.dispensariesSkippedNoBank).toBe(1);
    expect(aeropay.createPayoutCalls).toHaveLength(0);
    expect(payouts.updateStatusCalls).toEqual([
      expect.objectContaining({
        status: 'failed',
        patch: { failureReason: 'dispensary_bank_account_not_linked' },
      }),
    ]);
  });

  it('marks payout failed when the dispensary row is missing (ledger orphan)', async () => {
    const { deps, ledger, payouts, aeropay } = build();
    ledger.set('dispensary', [{ accountRef: DISP_D_GHOST, netCents: 8_000 }]);
    ledger.set('refund_reserve', []);

    const summary = await runPayoutJob({ now: NOW, deps });

    expect(summary.dispensariesFailed).toBe(1);
    expect(payouts.createIfAbsentCalls).toHaveLength(1);
    expect(payouts.createIfAbsentCalls[0]?.input.status).toBe('failed');
    expect(payouts.createIfAbsentCalls[0]?.input.failureReason).toBe('dispensary row not found');
    expect(aeropay.createPayoutCalls).toHaveLength(0);
  });

  it('skips Aeropay dispatch and counts as already-paid when payout row exists for the period', async () => {
    const { deps, dispensaries, ledger, payouts, aeropay } = build();
    dispensaries.add(makeDispensary({ id: DISP_A }));
    payouts.seedExisting({
      id: 'pre-existing',
      recipientType: 'dispensary',
      recipientId: DISP_A,
      periodStart: PERIOD_START_DATE,
      periodEnd: PERIOD_END_DATE,
      grossCents: 9_000,
      feesCents: 0,
      netCents: 9_000,
      status: 'processing',
      scheduledFor: PERIOD_END_DATE,
    });
    ledger.set('dispensary', [{ accountRef: DISP_A, netCents: 9_000 }]);
    ledger.set('refund_reserve', []);

    const summary = await runPayoutJob({ now: NOW, deps });

    expect(summary.dispensariesAlreadyPaid).toBe(1);
    expect(summary.dispensariesDispatched).toBe(0);
    expect(aeropay.createPayoutCalls).toHaveLength(0);
    expect(payouts.updateStatusCalls).toHaveLength(0);
  });

  it('marks failed and continues to the next dispensary when Aeropay createPayout throws', async () => {
    const { deps, dispensaries, ledger, payouts, aeropay } = build();
    dispensaries.add(makeDispensary({ id: DISP_A, aeropayAccountRef: 'bank_A' }));
    dispensaries.add(makeDispensary({ id: DISP_B, aeropayAccountRef: 'bank_B' }));
    ledger.set('dispensary', [
      { accountRef: DISP_A, netCents: 5_000 },
      { accountRef: DISP_B, netCents: 7_500 },
    ]);
    ledger.set('refund_reserve', []);
    aeropay.failNext = true;
    aeropay.failNextWith = new Error('aeropay sandbox 500');

    const summary = await runPayoutJob({ now: NOW, deps });

    expect(summary.dispensariesProcessed).toBe(2);
    expect(summary.dispensariesDispatched).toBe(1);
    expect(summary.dispensariesFailed).toBe(1);
    expect(payouts.updateStatusCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'failed',
          patch: { failureReason: 'aeropay sandbox 500' },
        }),
        expect.objectContaining({
          status: 'processing',
          patch: expect.objectContaining({ aeropayPayoutRef: expect.any(String) }),
        }),
      ]),
    );
  });
});

describe('runPayoutJob — driver path', () => {
  it('records driver payouts as pending without dispatching when no bank is linked', async () => {
    const { deps, drivers, ledger, payouts, aeropay } = build();
    ledger.set('dispensary', []);
    ledger.set('refund_reserve', []);
    ledger.set('driver', [
      { accountRef: DRIVER_1, netCents: 3_400 },
      { accountRef: DRIVER_2, netCents: 2_100 },
    ]);
    // DRIVER_1 has a profile but no linked bank; DRIVER_2 has no profile row
    // at all — both keep the earnings pending (owed, not lost).
    drivers.addUnlinked(DRIVER_1);

    const summary = await runPayoutJob({ now: NOW, deps });

    expect(summary.driversProcessed).toBe(2);
    expect(summary.driversPendingBank).toBe(2);
    expect(summary.driversDispatched).toBe(0);
    expect(summary.driversFailed).toBe(0);
    expect(aeropay.createPayoutCalls).toHaveLength(0);
    expect(
      payouts.createIfAbsentCalls.filter((c) => c.input.recipientType === 'driver'),
    ).toHaveLength(2);
    // Pending rows are NOT flipped to failed — the earnings are owed.
    expect(payouts.updateStatusCalls).toHaveLength(0);
    expect(
      payouts.createIfAbsentCalls.find((c) => c.input.recipientId === DRIVER_1)?.input.netCents,
    ).toBe(3_400);
  });

  it('dispatches a real Aeropay payout for a driver with a linked bank account', async () => {
    const { deps, drivers, ledger, payouts, aeropay } = build();
    ledger.set('dispensary', []);
    ledger.set('refund_reserve', []);
    ledger.set('driver', [{ accountRef: DRIVER_1, netCents: 3_400 }]);
    drivers.addLinked(DRIVER_1, 'bank_driver_1');

    const summary = await runPayoutJob({ now: NOW, deps });

    expect(summary.driversProcessed).toBe(1);
    expect(summary.driversDispatched).toBe(1);
    expect(summary.driversPendingBank).toBe(0);
    expect(aeropay.createPayoutCalls).toHaveLength(1);
    expect(aeropay.createPayoutCalls[0]?.bankAccountId).toBe('bank_driver_1');
    expect(aeropay.createPayoutCalls[0]?.amountCents).toBe(3_400);
    expect(aeropay.createPayoutCalls[0]?.recipientRef).toBe(`driver:${DRIVER_1}`);
    expect(aeropay.createPayoutCalls[0]?.idempotencyKey).toMatch(/^payout:/);
    expect(payouts.updateStatusCalls).toEqual([
      expect.objectContaining({
        status: 'processing',
        patch: expect.objectContaining({ aeropayPayoutRef: expect.any(String) }),
      }),
    ]);
  });

  it('marks a driver payout failed when the Aeropay dispatch throws', async () => {
    const { deps, drivers, ledger, payouts, aeropay } = build();
    ledger.set('dispensary', []);
    ledger.set('refund_reserve', []);
    ledger.set('driver', [{ accountRef: DRIVER_1, netCents: 3_400 }]);
    drivers.addLinked(DRIVER_1, 'bank_driver_1');
    aeropay.failNext = true;

    const summary = await runPayoutJob({ now: NOW, deps });

    expect(summary.driversFailed).toBe(1);
    expect(summary.driversDispatched).toBe(0);
    expect(payouts.updateStatusCalls).toEqual([
      expect.objectContaining({
        status: 'failed',
        patch: expect.objectContaining({ failureReason: expect.any(String) }),
      }),
    ]);
  });

  it('skips drivers with zero net earnings', async () => {
    const { deps, ledger, payouts } = build();
    ledger.set('dispensary', []);
    ledger.set('refund_reserve', []);
    ledger.set('driver', [{ accountRef: DRIVER_1, netCents: 0 }]);

    const summary = await runPayoutJob({ now: NOW, deps });

    expect(summary.driversSkippedNoEarnings).toBe(1);
    expect(summary.driversProcessed).toBe(0);
    expect(payouts.createIfAbsentCalls).toHaveLength(0);
  });

  it('counts re-runs against the same driver as already-paid', async () => {
    const { deps, ledger, payouts } = build();
    ledger.set('dispensary', []);
    ledger.set('refund_reserve', []);
    ledger.set('driver', [{ accountRef: DRIVER_1, netCents: 4_200 }]);
    payouts.seedExisting({
      id: 'pre-driver-1',
      recipientType: 'driver',
      recipientId: DRIVER_1,
      periodStart: PERIOD_START_DATE,
      periodEnd: PERIOD_END_DATE,
      grossCents: 4_200,
      feesCents: 0,
      netCents: 4_200,
      status: 'pending',
      scheduledFor: PERIOD_END_DATE,
    });

    const summary = await runPayoutJob({ now: NOW, deps });

    expect(summary.driversAlreadyPaid).toBe(1);
    expect(summary.driversPendingBank).toBe(0);
  });
});

describe('runPayoutJob — orchestration', () => {
  it('queries the ledger with the computed period window for each accountType', async () => {
    const { deps, ledger } = build();
    ledger.set('dispensary', []);
    ledger.set('refund_reserve', []);
    ledger.set('driver', []);

    await runPayoutJob({ now: NOW, deps });

    const types = ledger.calls.map((c) => c.accountType).sort();
    expect(types).toEqual(['dispensary', 'driver', 'refund_reserve']);
    for (const call of ledger.calls) {
      expect(call.periodStartUtc.toISOString()).toBe(PERIOD_START_UTC.toISOString());
      expect(call.periodEndUtc.toISOString()).toBe(PERIOD_END_UTC.toISOString());
    }
  });

  it('returns a summary with the period dates from computePayoutPeriod', async () => {
    const { deps, ledger } = build();
    ledger.set('dispensary', []);
    ledger.set('refund_reserve', []);
    ledger.set('driver', []);

    const summary = await runPayoutJob({ now: NOW, deps });

    expect(summary.periodStartDate).toBe(PERIOD_START_DATE);
    expect(summary.periodEndDate).toBe(PERIOD_END_DATE);
  });

  it('processes dispensaries and drivers in the same run', async () => {
    const { deps, dispensaries, ledger, payouts, aeropay } = build();
    dispensaries.add(makeDispensary({ id: DISP_A, aeropayAccountRef: 'bank_A' }));
    ledger.set('dispensary', [{ accountRef: DISP_A, netCents: 6_000 }]);
    ledger.set('refund_reserve', []);
    ledger.set('driver', [{ accountRef: DRIVER_1, netCents: 1_500 }]);

    const summary = await runPayoutJob({ now: NOW, deps });

    expect(summary.dispensariesDispatched).toBe(1);
    expect(summary.driversPendingBank).toBe(1);
    expect(aeropay.createPayoutCalls).toHaveLength(1);
    expect(payouts.createIfAbsentCalls.map((c) => c.input.recipientType).sort()).toEqual([
      'dispensary',
      'driver',
    ]);
  });
});
