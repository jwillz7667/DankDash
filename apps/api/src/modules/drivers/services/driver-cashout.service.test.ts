/**
 * Unit tests for DriverCashoutService.
 *
 * Coverage:
 *
 *   - Input validation: zero, negative, and non-integer `amountCents`
 *     raise `ValidationError` (422). The Zod DTO also gates these, but
 *     the service re-validates so internal callers cannot bypass.
 *   - Balance gate: requested > (lifetime earnings - outstanding payouts)
 *     raises `PaymentError('PAYMENT_AMOUNT_MISMATCH', …, 422)`. The
 *     happy path includes outstanding payouts in the denominator (a
 *     driver with $50 earned and $30 already cashed-out can withdraw at
 *     most $20).
 *   - Stub gateway happy path: creates a `payouts` row with status
 *     'pending', `period_start = period_end = epoch + N days` (N = prior
 *     count), and returns a DTO with `aeropayPayoutRef: null` and
 *     `status: 'pending'`. No `updateStatus` is called because the stub
 *     returned null.
 *   - Live gateway happy path: when the gateway returns an upstream
 *     payout ref, the service patches the row to `processing` and the
 *     DTO surfaces both the ref and the updated status.
 *   - Gateway error: a thrown `PaymentError` propagates; the row stays
 *     persisted (no rollback) so ops can inspect the failed attempt.
 *   - `countForRecipient` drives a distinct `period_start` per cashout
 *     so a driver with two same-day requests doesn't trip the
 *     `(recipient_type, recipient_id, period_start, period_end)` unique
 *     constraint designed for the daily windowed-payout job.
 *
 * Repos are hand-rolled fakes; same pattern as
 * `driver-orders.service.test.ts`. No testcontainer, no real DB.
 */
import { PaymentError, ValidationError } from '@dankdash/types';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DriverCashoutService,
  type AeropayDriverPayoutGateway,
  type DriverCashoutScopedRepos,
} from './driver-cashout.service.js';
import type {
  Database,
  NewPayout,
  OrdersRepository,
  Payout,
  PayoutsRepository,
  PayoutStatus,
  PayoutRecipient,
} from '@dankdash/db';

const DRIVER_USER_ID = '01935f3d-0000-7000-8000-0000000006a1';
const PAYOUT_ID_BASE = '01935f3d-0000-7000-8000-000000000700';
const FAKE_DB = {} as Database;
const PIN_NOW = new Date('2026-05-19T20:30:00.000Z');

interface SumEarningsInput {
  readonly driverId: string;
  readonly since: Date | null;
  readonly until: Date;
}
interface SumEarningsResult {
  readonly tipsCents: number;
  readonly deliveryFeesCents: number;
  readonly deliveriesCount: number;
}

class FakeOrdersRepo implements Pick<OrdersRepository, 'sumDriverEarnings'> {
  public result: SumEarningsResult = { tipsCents: 0, deliveryFeesCents: 0, deliveriesCount: 0 };
  public calls: SumEarningsInput[] = [];

  sumDriverEarnings(input: SumEarningsInput): Promise<SumEarningsResult> {
    this.calls.push(input);
    return Promise.resolve(this.result);
  }
}

type CreateInput = Omit<NewPayout, 'id'> & { readonly id?: string };
interface UpdateStatusInput {
  readonly id: string;
  readonly status: PayoutStatus;
  readonly patch: Partial<
    Pick<NewPayout, 'initiatedAt' | 'completedAt' | 'aeropayPayoutRef' | 'failureReason'>
  >;
}

class FakePayoutsRepo implements Pick<
  PayoutsRepository,
  'create' | 'updateStatus' | 'sumOutstandingFor' | 'countForRecipient'
> {
  public outstandingCents = 0;
  public priorCount = 0;
  public createCalls: CreateInput[] = [];
  public updateStatusCalls: UpdateStatusInput[] = [];
  public rows: Payout[] = [];
  /** Monotonic id sequence so multiple cashouts in one test get distinct ids. */
  private idSeq = 0;

  create(input: CreateInput): Promise<Payout> {
    this.createCalls.push(input);
    this.idSeq += 1;
    const id =
      input.id ?? `${PAYOUT_ID_BASE.slice(0, -2)}${this.idSeq.toString().padStart(2, '0')}`;
    const row: Payout = {
      id,
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
      createdAt: PIN_NOW,
      updatedAt: PIN_NOW,
    };
    this.rows.push(row);
    this.priorCount += 1;
    return Promise.resolve(row);
  }

  updateStatus(
    id: string,
    status: PayoutStatus,
    patch: Partial<
      Pick<NewPayout, 'initiatedAt' | 'completedAt' | 'aeropayPayoutRef' | 'failureReason'>
    > = {},
  ): Promise<Payout | null> {
    this.updateStatusCalls.push({ id, status, patch });
    const idx = this.rows.findIndex((r) => r.id === id);
    if (idx === -1) return Promise.resolve(null);
    const existing = this.rows[idx]!;
    const next: Payout = {
      ...existing,
      status,
      aeropayPayoutRef: patch.aeropayPayoutRef ?? existing.aeropayPayoutRef,
      initiatedAt: patch.initiatedAt ?? existing.initiatedAt,
      completedAt: patch.completedAt ?? existing.completedAt,
      failureReason: patch.failureReason ?? existing.failureReason,
      updatedAt: PIN_NOW,
    };
    this.rows[idx] = next;
    return Promise.resolve(next);
  }

  sumOutstandingFor(_recipientType: PayoutRecipient, _recipientId: string): Promise<number> {
    return Promise.resolve(this.outstandingCents);
  }

  countForRecipient(_recipientType: PayoutRecipient, _recipientId: string): Promise<number> {
    return Promise.resolve(this.priorCount);
  }
}

class FakeGateway implements AeropayDriverPayoutGateway {
  public calls: { payoutId: string; driverUserId: string; amountCents: number }[] = [];
  public mode: 'stub' | 'live' | 'throw' = 'stub';
  public liveRef = 'aero_test_abc123';
  public error: Error = new PaymentError('PAYMENT_PROVIDER_UNAVAILABLE', 'aeropay down', {}, 502);

  requestPayout(input: {
    readonly payoutId: string;
    readonly driverUserId: string;
    readonly amountCents: number;
  }): Promise<string | null> {
    this.calls.push({ ...input });
    if (this.mode === 'throw') return Promise.reject(this.error);
    if (this.mode === 'live') return Promise.resolve(this.liveRef);
    return Promise.resolve(null);
  }
}

interface Rig {
  readonly service: DriverCashoutService;
  readonly orders: FakeOrdersRepo;
  readonly payouts: FakePayoutsRepo;
  readonly gateway: FakeGateway;
}

function makeRig(): Rig {
  const orders = new FakeOrdersRepo();
  const payouts = new FakePayoutsRepo();
  const gateway = new FakeGateway();
  const scoped: DriverCashoutScopedRepos = {
    orders: orders as unknown as OrdersRepository,
    payouts: payouts as unknown as PayoutsRepository,
  };
  const service = new DriverCashoutService(FAKE_DB, () => scoped, gateway, {
    clock: () => PIN_NOW,
  });
  return { service, orders, payouts, gateway };
}

describe('DriverCashoutService.requestCashout — input validation', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
  });

  it('rejects amountCents = 0 with ValidationError', async () => {
    await expect(rig.service.requestCashout(DRIVER_USER_ID, 0)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(rig.payouts.createCalls).toHaveLength(0);
    expect(rig.orders.calls).toHaveLength(0);
  });

  it('rejects a negative amountCents', async () => {
    await expect(rig.service.requestCashout(DRIVER_USER_ID, -1)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects a non-integer amountCents', async () => {
    await expect(rig.service.requestCashout(DRIVER_USER_ID, 12.5)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('DriverCashoutService.requestCashout — balance gate', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
  });

  it('throws PAYMENT_AMOUNT_MISMATCH 422 when requested > available', async () => {
    rig.orders.result = { tipsCents: 1_500, deliveryFeesCents: 3_500, deliveriesCount: 5 };
    rig.payouts.outstandingCents = 0;

    // available = 5000; request 6000 → fail.
    const promise = rig.service.requestCashout(DRIVER_USER_ID, 6_000);
    await expect(promise).rejects.toBeInstanceOf(PaymentError);
    await expect(promise).rejects.toMatchObject({
      code: 'PAYMENT_AMOUNT_MISMATCH',
      statusCode: 422,
      details: {
        requestedCents: 6_000,
        availableCents: 5_000,
        lifetimeCents: 5_000,
        outstandingCents: 0,
      },
    });
    expect(rig.payouts.createCalls).toHaveLength(0);
    expect(rig.gateway.calls).toHaveLength(0);
  });

  it('subtracts outstanding payouts from the denominator', async () => {
    rig.orders.result = { tipsCents: 2_000, deliveryFeesCents: 3_000, deliveriesCount: 5 };
    rig.payouts.outstandingCents = 3_000;

    // lifetime=5000, outstanding=3000 → available=2000. Request 2001 must fail.
    await expect(rig.service.requestCashout(DRIVER_USER_ID, 2_001)).rejects.toMatchObject({
      code: 'PAYMENT_AMOUNT_MISMATCH',
      details: { availableCents: 2_000, outstandingCents: 3_000 },
    });
  });

  it('passes the cashout query as a lifetime [null, now) window', async () => {
    rig.orders.result = { tipsCents: 1_000, deliveryFeesCents: 1_000, deliveriesCount: 1 };
    await rig.service.requestCashout(DRIVER_USER_ID, 1_500);
    expect(rig.orders.calls).toHaveLength(1);
    expect(rig.orders.calls[0]!.driverId).toBe(DRIVER_USER_ID);
    expect(rig.orders.calls[0]!.since).toBeNull();
    expect(rig.orders.calls[0]!.until).toBe(PIN_NOW);
  });
});

describe('DriverCashoutService.requestCashout — stub gateway happy path', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
    rig.orders.result = { tipsCents: 4_000, deliveryFeesCents: 6_000, deliveriesCount: 8 };
    rig.payouts.outstandingCents = 0;
  });

  it('persists a pending payout row and returns the wire DTO with aeropayPayoutRef=null', async () => {
    const out = await rig.service.requestCashout(DRIVER_USER_ID, 4_000);

    expect(rig.payouts.createCalls).toHaveLength(1);
    const createInput = rig.payouts.createCalls[0]!;
    expect(createInput.recipientType).toBe('driver');
    expect(createInput.recipientId).toBe(DRIVER_USER_ID);
    expect(createInput.grossCents).toBe(4_000);
    expect(createInput.netCents).toBe(4_000);
    expect(createInput.feesCents).toBe(0);
    expect(createInput.status).toBe('pending');
    // scheduledFor is UTC calendar-string for today (PIN_NOW = 2026-05-19 UTC).
    expect(createInput.scheduledFor).toBe('2026-05-19');
    // priorCount was 0 → epoch + 0 days = 1970-01-01.
    expect(createInput.periodStart).toBe('1970-01-01');
    expect(createInput.periodEnd).toBe('1970-01-01');

    expect(rig.gateway.calls).toHaveLength(1);
    expect(rig.gateway.calls[0]!.amountCents).toBe(4_000);
    expect(rig.gateway.calls[0]!.driverUserId).toBe(DRIVER_USER_ID);

    // Stub returned null → no updateStatus call, status stays 'pending'.
    expect(rig.payouts.updateStatusCalls).toHaveLength(0);

    expect(out.amountCents).toBe(4_000);
    expect(out.status).toBe('pending');
    expect(out.aeropayPayoutRef).toBeNull();
    expect(out.requestedAt).toBe(PIN_NOW.toISOString());
    expect(out.id).toBe(rig.payouts.rows[0]!.id);
  });

  it('allows a cashout for the full available balance', async () => {
    const out = await rig.service.requestCashout(DRIVER_USER_ID, 10_000);
    expect(out.amountCents).toBe(10_000);
    expect(rig.payouts.createCalls).toHaveLength(1);
  });
});

describe('DriverCashoutService.requestCashout — live gateway happy path', () => {
  it('patches the row to processing and surfaces the upstream ref', async () => {
    const rig = makeRig();
    rig.orders.result = { tipsCents: 5_000, deliveryFeesCents: 5_000, deliveriesCount: 10 };
    rig.gateway.mode = 'live';
    rig.gateway.liveRef = 'aero_pmt_xyz';

    const out = await rig.service.requestCashout(DRIVER_USER_ID, 7_500);

    expect(rig.payouts.updateStatusCalls).toHaveLength(1);
    const upd = rig.payouts.updateStatusCalls[0]!;
    expect(upd.id).toBe(rig.payouts.rows[0]!.id);
    expect(upd.status).toBe('processing');
    expect(upd.patch.aeropayPayoutRef).toBe('aero_pmt_xyz');
    expect(upd.patch.initiatedAt).toBe(PIN_NOW);

    expect(out.status).toBe('processing');
    expect(out.aeropayPayoutRef).toBe('aero_pmt_xyz');
  });
});

describe('DriverCashoutService.requestCashout — gateway error', () => {
  it('persists the row, then rethrows the PaymentError so the controller sees it', async () => {
    const rig = makeRig();
    rig.orders.result = { tipsCents: 0, deliveryFeesCents: 10_000, deliveriesCount: 5 };
    rig.gateway.mode = 'throw';

    await expect(rig.service.requestCashout(DRIVER_USER_ID, 5_000)).rejects.toBeInstanceOf(
      PaymentError,
    );

    // The row IS persisted — ops can inspect the failure later.
    expect(rig.payouts.createCalls).toHaveLength(1);
    expect(rig.payouts.rows).toHaveLength(1);
    expect(rig.payouts.rows[0]!.status).toBe('pending');
    // No status update — the catch path does not roll forward.
    expect(rig.payouts.updateStatusCalls).toHaveLength(0);
  });
});

describe('DriverCashoutService.requestCashout — period_start uniqueness shim', () => {
  it('assigns each successive cashout a distinct period date so the unique constraint never trips', async () => {
    const rig = makeRig();
    rig.orders.result = { tipsCents: 20_000, deliveryFeesCents: 30_000, deliveriesCount: 30 };

    await rig.service.requestCashout(DRIVER_USER_ID, 1_000);
    await rig.service.requestCashout(DRIVER_USER_ID, 1_000);
    await rig.service.requestCashout(DRIVER_USER_ID, 1_000);

    expect(rig.payouts.createCalls).toHaveLength(3);
    const periods = rig.payouts.createCalls.map((c) => `${c.periodStart}..${c.periodEnd}`);
    // Epoch+0 / Epoch+1 / Epoch+2 — all distinct.
    expect(periods).toStrictEqual([
      '1970-01-01..1970-01-01',
      '1970-01-02..1970-01-02',
      '1970-01-03..1970-01-03',
    ]);
    // And scheduledFor stays today across all three.
    expect(rig.payouts.createCalls.every((c) => c.scheduledFor === '2026-05-19')).toBe(true);
  });
});
