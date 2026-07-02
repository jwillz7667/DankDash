/**
 * Settlement-reconciliation worker — outcome tests.
 *
 * Exercised with a hand-rolled PayoutsRepository fake + a fake Aeropay
 * client so every branch is covered without a database or a live upstream:
 *
 *   - upstream `paid`         → processing → completed
 *   - upstream `failed`       → processing → failed (reason)
 *   - upstream pending/in_transit → left processing
 *   - upstream 404 past orphan age → failed `reconciliation_orphan`
 *   - upstream 404 within grace   → left processing
 *   - a row settled by a concurrent webhook between list + update → no clobber
 *   - a processing row with no aeropay ref → skipped, logged
 *   - a transient Aeropay error → counted, isolated (run continues)
 *   - input validation guards
 */
import { type AeropayPayout } from '@dankdash/aeropay';
import { type Payout, type PayoutStatus } from '@dankdash/db';
import { PaymentError } from '@dankdash/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ORPHAN_AFTER_HOURS,
  DEFAULT_STUCK_AFTER_MINUTES,
  runPayoutReconciliationJob,
  type PayoutReconciliationJobDeps,
} from './payout-reconciliation.job.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const PAYOUT_ID = '00000000-0000-7000-8000-0000000000f1';
const DISPENSARY_ID = '00000000-0000-7000-8000-0000000000a1';
const AEROPAY_REF = 'po_aeropay_recon_1';
// Older than the 24h orphan threshold relative to NOW.
const OLD_INITIATED_AT = new Date('2026-05-30T00:00:00.000Z');
// Newer than 24h before NOW (within orphan grace).
const YOUNG_INITIATED_AT = new Date('2026-06-01T06:00:00.000Z');

function makePayout(overrides: Partial<Payout> = {}): Payout {
  return {
    id: PAYOUT_ID,
    recipientType: 'dispensary',
    recipientId: DISPENSARY_ID,
    periodStart: '2026-05-29',
    periodEnd: '2026-05-30',
    grossCents: 12_500,
    feesCents: 0,
    netCents: 12_500,
    aeropayPayoutRef: AEROPAY_REF,
    status: 'processing',
    scheduledFor: '2026-05-30',
    initiatedAt: OLD_INITIATED_AT,
    completedAt: null,
    failureReason: null,
    createdAt: OLD_INITIATED_AT,
    updatedAt: OLD_INITIATED_AT,
    ...overrides,
  };
}

function makeUpstream(overrides: Partial<AeropayPayout> = {}): AeropayPayout {
  return {
    id: AEROPAY_REF,
    status: 'paid',
    amountCents: 12_500,
    bankAccountId: 'ba_1',
    recipientRef: `dispensary:${DISPENSARY_ID}`,
    periodStart: new Date('2026-05-29T00:00:00.000Z'),
    periodEnd: new Date('2026-05-30T00:00:00.000Z'),
    createdAt: OLD_INITIATED_AT,
    ...overrides,
  };
}

interface UpdateCall {
  readonly id: string;
  readonly status: PayoutStatus;
  readonly patch: Record<string, unknown>;
}

class FakePayoutsRepo {
  rows: Payout[] = [];
  updateCalls: UpdateCall[] = [];

  listStuckProcessing = (initiatedBefore: Date, limit: number): Promise<readonly Payout[]> =>
    Promise.resolve(
      this.rows
        .filter(
          (r) =>
            r.status === 'processing' && r.initiatedAt !== null && r.initiatedAt < initiatedBefore,
        )
        .slice(0, limit),
    );

  findById = (id: string): Promise<Payout | null> =>
    Promise.resolve(this.rows.find((r) => r.id === id) ?? null);

  updateStatus = (
    id: string,
    status: PayoutStatus,
    patch: Record<string, unknown> = {},
  ): Promise<Payout | null> => {
    this.updateCalls.push({ id, status, patch });
    const row = this.rows.find((r) => r.id === id);
    if (row === undefined) return Promise.resolve(null);
    row.status = status;
    return Promise.resolve(row);
  };
}

function makeLogger(): {
  error: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  child: () => unknown;
} {
  const stub = {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: (): unknown => stub,
  };
  return stub;
}

function build(opts: { getPayout?: ReturnType<typeof vi.fn> } = {}): {
  deps: PayoutReconciliationJobDeps;
  repo: FakePayoutsRepo;
  getPayout: ReturnType<typeof vi.fn>;
  logger: ReturnType<typeof makeLogger>;
} {
  const repo = new FakePayoutsRepo();
  const getPayout = opts.getPayout ?? vi.fn().mockResolvedValue(makeUpstream());
  const logger = makeLogger();
  const deps = {
    payouts: repo,
    aeropay: { getPayout },
    logger,
  } as unknown as PayoutReconciliationJobDeps;
  return { deps, repo, getPayout, logger };
}

function notFound(): PaymentError {
  return new PaymentError('PAYMENT_METHOD_INVALID', 'Aeropay resource not found', {}, 404);
}

describe('runPayoutReconciliationJob defaults', () => {
  it('exposes sane threshold defaults', () => {
    expect(DEFAULT_STUCK_AFTER_MINUTES).toBe(15);
    expect(DEFAULT_ORPHAN_AFTER_HOURS).toBe(24);
  });
});

describe('runPayoutReconciliationJob', () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it('completes a stuck payout Aeropay reports as paid', async () => {
    ctx.repo.rows.push(makePayout({ status: 'processing' }));

    const summary = await runPayoutReconciliationJob({ now: NOW, deps: ctx.deps });

    expect(ctx.getPayout).toHaveBeenCalledWith(AEROPAY_REF);
    expect(ctx.repo.updateCalls).toEqual([
      { id: PAYOUT_ID, status: 'completed', patch: { completedAt: NOW } },
    ]);
    expect(summary).toMatchObject({ scanned: 1, completed: 1, failed: 0, orphaned: 0, errors: 0 });
  });

  it('fails a stuck payout Aeropay reports as failed with reconciliation_failed', async () => {
    ctx = build({ getPayout: vi.fn().mockResolvedValue(makeUpstream({ status: 'failed' })) });
    ctx.repo.rows.push(makePayout({ status: 'processing' }));

    const summary = await runPayoutReconciliationJob({ now: NOW, deps: ctx.deps });

    expect(ctx.repo.updateCalls).toEqual([
      { id: PAYOUT_ID, status: 'failed', patch: { failureReason: 'reconciliation_failed' } },
    ]);
    expect(summary).toMatchObject({ failed: 1, completed: 0 });
  });

  it('leaves a payout still moving (pending / in_transit) untouched', async () => {
    ctx = build({ getPayout: vi.fn().mockResolvedValue(makeUpstream({ status: 'in_transit' })) });
    ctx.repo.rows.push(makePayout({ status: 'processing' }));

    const summary = await runPayoutReconciliationJob({ now: NOW, deps: ctx.deps });

    expect(ctx.repo.updateCalls).toHaveLength(0);
    expect(summary).toMatchObject({ scanned: 1, stillPending: 1 });
  });

  it('orphans a payout Aeropay does not recognize once past the orphan age', async () => {
    ctx = build({ getPayout: vi.fn().mockRejectedValue(notFound()) });
    ctx.repo.rows.push(makePayout({ status: 'processing', initiatedAt: OLD_INITIATED_AT }));

    const summary = await runPayoutReconciliationJob({ now: NOW, deps: ctx.deps });

    expect(ctx.repo.updateCalls).toEqual([
      { id: PAYOUT_ID, status: 'failed', patch: { failureReason: 'reconciliation_orphan' } },
    ]);
    expect(summary).toMatchObject({ orphaned: 1, failed: 0 });
    expect(ctx.logger.error).toHaveBeenCalled();
  });

  it('does not orphan a 404 payout still within the orphan grace window', async () => {
    ctx = build({ getPayout: vi.fn().mockRejectedValue(notFound()) });
    ctx.repo.rows.push(makePayout({ status: 'processing', initiatedAt: YOUNG_INITIATED_AT }));

    const summary = await runPayoutReconciliationJob({ now: NOW, deps: ctx.deps });

    expect(ctx.repo.updateCalls).toHaveLength(0);
    expect(summary).toMatchObject({ orphaned: 0, stillPending: 1 });
  });

  it('does not clobber a row a concurrent webhook already completed', async () => {
    // The list snapshot saw `processing`, but by the time findById runs the
    // webhook has moved it to `completed`. The shared resolver keeps us from
    // regressing / re-stamping a terminal row.
    const row = makePayout({ status: 'processing' });
    ctx.repo.rows.push(row);
    const originalFindById = ctx.repo.findById;
    ctx.repo.findById = (id: string) => {
      row.status = 'completed'; // simulate the webhook landing first
      return originalFindById(id);
    };

    const summary = await runPayoutReconciliationJob({ now: NOW, deps: ctx.deps });

    expect(ctx.repo.updateCalls).toHaveLength(0);
    expect(summary).toMatchObject({ completed: 0, stillPending: 1 });
  });

  it('skips a processing row that has no aeropay_payout_ref and logs loudly', async () => {
    ctx.repo.rows.push(makePayout({ status: 'processing', aeropayPayoutRef: null }));

    const summary = await runPayoutReconciliationJob({ now: NOW, deps: ctx.deps });

    expect(ctx.getPayout).not.toHaveBeenCalled();
    expect(ctx.repo.updateCalls).toHaveLength(0);
    expect(summary).toMatchObject({ scanned: 1, skippedNoRef: 1 });
    expect(ctx.logger.error).toHaveBeenCalled();
  });

  it('isolates a transient Aeropay error and keeps processing the rest', async () => {
    const goodRow = makePayout({ status: 'processing' });
    const badRow = makePayout({
      id: '00000000-0000-7000-8000-0000000000f2',
      aeropayPayoutRef: 'po_bad',
      status: 'processing',
    });
    ctx.repo.rows.push(badRow, goodRow);
    ctx.getPayout.mockImplementation((ref: string) => {
      if (ref === 'po_bad') {
        return Promise.reject(
          new PaymentError('PAYMENT_PROVIDER_UNAVAILABLE', 'Aeropay 5xx', {}, 502),
        );
      }
      return Promise.resolve(makeUpstream());
    });

    const summary = await runPayoutReconciliationJob({ now: NOW, deps: ctx.deps });

    expect(summary).toMatchObject({ scanned: 2, completed: 1, errors: 1 });
    expect(ctx.logger.error).toHaveBeenCalled();
  });

  it('reports an empty summary when nothing is stuck', async () => {
    const summary = await runPayoutReconciliationJob({ now: NOW, deps: ctx.deps });
    expect(summary).toEqual({
      scanned: 0,
      completed: 0,
      failed: 0,
      orphaned: 0,
      stillPending: 0,
      skippedNoRef: 0,
      errors: 0,
    });
  });

  it('rejects a negative stuck threshold', async () => {
    const { deps } = build();
    await expect(
      runPayoutReconciliationJob({ now: NOW, deps: { ...deps, stuckAfterMinutes: -1 } }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('rejects a negative orphan threshold', async () => {
    const { deps } = build();
    await expect(
      runPayoutReconciliationJob({ now: NOW, deps: { ...deps, orphanAfterHours: -1 } }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('rejects a non-positive batch limit', async () => {
    const { deps } = build();
    await expect(
      runPayoutReconciliationJob({ now: NOW, deps: { ...deps, batchLimit: 0 } }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
