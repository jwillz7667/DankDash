/**
 * PayoutWebhookService unit tests with a hand-rolled PayoutsRepository fake.
 * Pins 100% of the payout-completion branches:
 *
 *   - applyPaid()  : processing → completed; completed replay; unknown ref;
 *                    unexpected non-processing status left untouched.
 *   - applyFailed(): processing → failed (reason from envelope + fallback);
 *                    failed replay; unknown ref; unexpected status untouched.
 */
import {
  type NewPayout,
  type Payout,
  type PayoutStatus,
  type PayoutsRepository,
} from '@dankdash/db';
import { describe, expect, it } from 'vitest';
import { PayoutWebhookService } from './payout-webhook.service.js';

const PAYOUT_ID = '01935f3d-0000-7000-8000-0000000000f1';
const DISPENSARY_ID = '01935f3d-0000-7000-8000-0000000000a1';
const AEROPAY_PAYOUT_REF = 'po_aeropay_abc123';
const OCCURRED_AT = new Date('2026-05-06T09:00:00.000Z');

type StatusPatch = Partial<
  Pick<NewPayout, 'initiatedAt' | 'completedAt' | 'aeropayPayoutRef' | 'failureReason'>
>;

function makePayout(overrides: Partial<Payout> = {}): Payout {
  return {
    id: PAYOUT_ID,
    recipientType: 'dispensary',
    recipientId: DISPENSARY_ID,
    periodStart: '2026-05-04',
    periodEnd: '2026-05-05',
    grossCents: 12_500,
    feesCents: 0,
    netCents: 12_500,
    aeropayPayoutRef: AEROPAY_PAYOUT_REF,
    status: 'processing',
    scheduledFor: '2026-05-05',
    initiatedAt: new Date('2026-05-05T09:00:00.000Z'),
    completedAt: null,
    failureReason: null,
    createdAt: new Date('2026-05-05T09:00:00.000Z'),
    updatedAt: new Date('2026-05-05T09:00:00.000Z'),
    ...overrides,
  };
}

class FakePayoutsRepo {
  rows: Payout[] = [];
  updateCalls: Array<{ id: string; status: PayoutStatus; patch: StatusPatch }> = [];

  findByAeropayPayoutRef = (ref: string): Promise<Payout | null> => {
    return Promise.resolve(this.rows.find((r) => r.aeropayPayoutRef === ref) ?? null);
  };

  updateStatus = (
    id: string,
    status: PayoutStatus,
    patch: StatusPatch = {},
  ): Promise<Payout | null> => {
    this.updateCalls.push({ id, status, patch });
    const row = this.rows.find((r) => r.id === id);
    if (row === undefined) return Promise.resolve(null);
    row.status = status;
    return Promise.resolve(row);
  };
}

function build(): { service: PayoutWebhookService; repo: FakePayoutsRepo } {
  const repo = new FakePayoutsRepo();
  const service = new PayoutWebhookService(repo as unknown as PayoutsRepository);
  return { service, repo };
}

describe('PayoutWebhookService.applyPaid', () => {
  it('moves a processing payout to completed and stamps completed_at', async () => {
    const { service, repo } = build();
    repo.rows.push(makePayout({ status: 'processing' }));

    await service.applyPaid(AEROPAY_PAYOUT_REF, OCCURRED_AT);

    expect(repo.updateCalls).toEqual([
      { id: PAYOUT_ID, status: 'completed', patch: { completedAt: OCCURRED_AT } },
    ]);
  });

  it('is a no-op on replay when the payout is already completed', async () => {
    const { service, repo } = build();
    repo.rows.push(makePayout({ status: 'completed' }));

    await service.applyPaid(AEROPAY_PAYOUT_REF, OCCURRED_AT);

    expect(repo.updateCalls).toHaveLength(0);
  });

  it('is benign when no payout matches the ref', async () => {
    const { service, repo } = build();

    await service.applyPaid('po_unknown', OCCURRED_AT);

    expect(repo.updateCalls).toHaveLength(0);
  });

  it('does not clobber a terminal failed payout with a late paid event', async () => {
    const { service, repo } = build();
    repo.rows.push(makePayout({ status: 'failed' }));

    await service.applyPaid(AEROPAY_PAYOUT_REF, OCCURRED_AT);

    expect(repo.updateCalls).toHaveLength(0);
  });
});

describe('PayoutWebhookService.applyFailed', () => {
  it('moves a processing payout to failed with the upstream reason', async () => {
    const { service, repo } = build();
    repo.rows.push(makePayout({ status: 'processing' }));

    await service.applyFailed(AEROPAY_PAYOUT_REF, {
      data: { object: { failure_reason: 'bank_account_closed' } },
    });

    expect(repo.updateCalls).toEqual([
      { id: PAYOUT_ID, status: 'failed', patch: { failureReason: 'bank_account_closed' } },
    ]);
  });

  it('records a stable fallback reason when the envelope carries none', async () => {
    const { service, repo } = build();
    repo.rows.push(makePayout({ status: 'processing' }));

    await service.applyFailed(AEROPAY_PAYOUT_REF, {});

    expect(repo.updateCalls[0]?.patch.failureReason).toBe('aeropay_payout_failed');
  });

  it('falls back when data.object is present but failure_reason is missing', async () => {
    const { service, repo } = build();
    repo.rows.push(makePayout({ status: 'processing' }));

    await service.applyFailed(AEROPAY_PAYOUT_REF, { data: { object: {} } });

    expect(repo.updateCalls[0]?.patch.failureReason).toBe('aeropay_payout_failed');
  });

  it('falls back when data is present but not an object', async () => {
    const { service, repo } = build();
    repo.rows.push(makePayout({ status: 'processing' }));

    await service.applyFailed(AEROPAY_PAYOUT_REF, { data: 'nope' });

    expect(repo.updateCalls[0]?.patch.failureReason).toBe('aeropay_payout_failed');
  });

  it('falls back when data is an object but data.object is absent', async () => {
    const { service, repo } = build();
    repo.rows.push(makePayout({ status: 'processing' }));

    await service.applyFailed(AEROPAY_PAYOUT_REF, { data: {} });

    expect(repo.updateCalls[0]?.patch.failureReason).toBe('aeropay_payout_failed');
  });

  it('is a no-op on replay when the payout is already failed', async () => {
    const { service, repo } = build();
    repo.rows.push(makePayout({ status: 'failed' }));

    await service.applyFailed(AEROPAY_PAYOUT_REF, {});

    expect(repo.updateCalls).toHaveLength(0);
  });

  it('is benign when no payout matches the ref', async () => {
    const { service, repo } = build();

    await service.applyFailed('po_unknown', {});

    expect(repo.updateCalls).toHaveLength(0);
  });

  it('does not clobber a terminal completed payout with a late failed event', async () => {
    const { service, repo } = build();
    repo.rows.push(makePayout({ status: 'completed' }));

    await service.applyFailed(AEROPAY_PAYOUT_REF, {});

    expect(repo.updateCalls).toHaveLength(0);
  });
});
