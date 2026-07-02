/**
 * DispensaryBankLinkService unit tests with hand-rolled fakes for the
 * dispensaries repo + Aeropay client. Pins 100% of the payout-linking
 * branches the Phase 6 DoD requires:
 *
 *   - startLink() opens a namespaced (`dispensary:<id>`) hosted session.
 *   - getStatus() reports linked/unlinked and 404s a vanished dispensary.
 *   - applyBankLinked() persists the ref, dedupes replays, tolerates an
 *     unknown dispensary, and raises on a mid-write vanish.
 *   - applyBankFailed() is a logged no-op.
 *   - the customer_ref namespacing helpers round-trip and reject bare refs.
 */
import { type Dispensary, type DispensariesRepository, type NewDispensary } from '@dankdash/db';
import { NotFoundError, PaymentError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import {
  DispensaryBankLinkService,
  buildDispensaryCustomerRef,
  parseDispensaryCustomerRef,
} from './dispensary-bank-link.service.js';
import type { AeropayLinkSession } from '@dankdash/aeropay';
import type { AeropayClientLike } from './tokens.js';
import type { VendorContext } from '../listings/vendor/vendor-context.types.js';

const DISPENSARY_ID = '01935f3d-0000-7000-8000-0000000000a1';
const STAFF_MEMBER_ID = '01935f3d-0000-7000-8000-0000000000a2';
const USER_ID = '01935f3d-0000-7000-8000-000000000001';
const RETURN_URL = 'https://portal.dankdash.com/payouts/bank/return';

const CTX: VendorContext = {
  dispensaryId: DISPENSARY_ID,
  userId: USER_ID,
  staffRole: 'owner',
  staffMemberId: STAFF_MEMBER_ID,
};

function makeDispensary(overrides: Partial<Dispensary> = {}): Dispensary {
  // Only `aeropayAccountRef` is read by the service; the rest is padded to
  // satisfy the type without pretending to be a realistic full row.
  return {
    id: DISPENSARY_ID,
    aeropayAccountRef: null,
    ...overrides,
  } as unknown as Dispensary;
}

class FakeDispensariesRepo {
  rows = new Map<string, Dispensary>();
  updateCalls: Array<{ id: string; patch: Partial<NewDispensary> }> = [];
  returnNullOnUpdate = false;

  findById = (id: string): Promise<Dispensary | null> => {
    return Promise.resolve(this.rows.get(id) ?? null);
  };

  update = (id: string, patch: Partial<NewDispensary>): Promise<Dispensary | null> => {
    this.updateCalls.push({ id, patch });
    if (this.returnNullOnUpdate) return Promise.resolve(null);
    const row = this.rows.get(id);
    if (row === undefined) return Promise.resolve(null);
    const next = { ...row, ...patch } as Dispensary;
    this.rows.set(id, next);
    return Promise.resolve(next);
  };
}

class FakeAeropayClient implements Pick<AeropayClientLike, 'linkBankAccount'> {
  linkCalls: Array<{ customerRef: string; returnUrl: string }> = [];
  nextLinkSession: AeropayLinkSession = {
    id: 'link_session_disp_1',
    hostedUrl: 'https://link.aeropay.com/session/disp_1',
    expiresAt: new Date('2026-05-01T03:00:00.000Z'),
  };

  linkBankAccount = (input: {
    customerRef: string;
    returnUrl: string;
  }): Promise<AeropayLinkSession> => {
    this.linkCalls.push(input);
    return Promise.resolve(this.nextLinkSession);
  };
}

function build(): {
  service: DispensaryBankLinkService;
  repo: FakeDispensariesRepo;
  aeropay: FakeAeropayClient;
} {
  const repo = new FakeDispensariesRepo();
  const aeropay = new FakeAeropayClient();
  const service = new DispensaryBankLinkService(
    repo as unknown as DispensariesRepository,
    aeropay as unknown as AeropayClientLike,
  );
  return { service, repo, aeropay };
}

describe('customer_ref namespacing helpers', () => {
  it('round-trips a dispensary id through build/parse', () => {
    const ref = buildDispensaryCustomerRef(DISPENSARY_ID);

    expect(ref).toBe(`dispensary:${DISPENSARY_ID}`);
    expect(parseDispensaryCustomerRef(ref)).toBe(DISPENSARY_ID);
  });

  it('returns null for a bare consumer ref (no prefix)', () => {
    expect(parseDispensaryCustomerRef(USER_ID)).toBeNull();
  });

  it('returns null for the prefix with an empty id', () => {
    expect(parseDispensaryCustomerRef('dispensary:')).toBeNull();
  });
});

describe('DispensaryBankLinkService.startLink', () => {
  it('opens a hosted session with the namespaced customer_ref and returns the URL', async () => {
    const { service, aeropay } = build();

    const res = await service.startLink(CTX, RETURN_URL);

    expect(aeropay.linkCalls).toEqual([
      { customerRef: `dispensary:${DISPENSARY_ID}`, returnUrl: RETURN_URL },
    ]);
    expect(res).toEqual({
      link: {
        id: 'link_session_disp_1',
        hostedUrl: 'https://link.aeropay.com/session/disp_1',
        expiresAt: '2026-05-01T03:00:00.000Z',
      },
    });
  });
});

describe('DispensaryBankLinkService.getStatus', () => {
  it('reports linked=false when no ref is on file', async () => {
    const { service, repo } = build();
    repo.rows.set(DISPENSARY_ID, makeDispensary({ aeropayAccountRef: null }));

    expect(await service.getStatus(CTX)).toEqual({ linked: false });
  });

  it('reports linked=true when a ref is on file', async () => {
    const { service, repo } = build();
    repo.rows.set(DISPENSARY_ID, makeDispensary({ aeropayAccountRef: 'ba_real_1' }));

    expect(await service.getStatus(CTX)).toEqual({ linked: true });
  });

  it('raises NotFoundError when the dispensary row is missing', async () => {
    const { service } = build();

    await expect(service.getStatus(CTX)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('DispensaryBankLinkService.applyBankLinked', () => {
  it('persists the confirmed bank-account id onto the dispensary', async () => {
    const { service, repo } = build();
    repo.rows.set(DISPENSARY_ID, makeDispensary({ aeropayAccountRef: null }));

    await service.applyBankLinked(DISPENSARY_ID, 'ba_real_1');

    expect(repo.updateCalls).toEqual([
      { id: DISPENSARY_ID, patch: { aeropayAccountRef: 'ba_real_1' } },
    ]);
    expect(repo.rows.get(DISPENSARY_ID)?.aeropayAccountRef).toBe('ba_real_1');
  });

  it('is a no-op when the same account id is already on file (replay)', async () => {
    const { service, repo } = build();
    repo.rows.set(DISPENSARY_ID, makeDispensary({ aeropayAccountRef: 'ba_real_1' }));

    await service.applyBankLinked(DISPENSARY_ID, 'ba_real_1');

    expect(repo.updateCalls).toHaveLength(0);
  });

  it('overwrites an existing ref on a relink to a different account', async () => {
    const { service, repo } = build();
    repo.rows.set(DISPENSARY_ID, makeDispensary({ aeropayAccountRef: 'ba_old' }));

    await service.applyBankLinked(DISPENSARY_ID, 'ba_new');

    expect(repo.rows.get(DISPENSARY_ID)?.aeropayAccountRef).toBe('ba_new');
  });

  it('is benign when the dispensary is unknown (no throw, no write)', async () => {
    const { service, repo } = build();

    await service.applyBankLinked(DISPENSARY_ID, 'ba_real_1');

    expect(repo.updateCalls).toHaveLength(0);
  });

  it('raises PAYMENT_METHOD_INVALID when the row vanishes mid-write', async () => {
    const { service, repo } = build();
    repo.rows.set(DISPENSARY_ID, makeDispensary({ aeropayAccountRef: null }));
    repo.returnNullOnUpdate = true;

    await expect(service.applyBankLinked(DISPENSARY_ID, 'ba_real_1')).rejects.toBeInstanceOf(
      PaymentError,
    );
  });
});

describe('DispensaryBankLinkService.applyBankFailed', () => {
  it('does not touch the dispensary row', () => {
    const { service, repo } = build();
    repo.rows.set(DISPENSARY_ID, makeDispensary({ aeropayAccountRef: 'ba_real_1' }));

    service.applyBankFailed(DISPENSARY_ID);

    expect(repo.updateCalls).toHaveLength(0);
    expect(repo.rows.get(DISPENSARY_ID)?.aeropayAccountRef).toBe('ba_real_1');
  });
});
