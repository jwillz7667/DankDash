/**
 * DriverBankLinkService unit tests with hand-rolled fakes for the drivers
 * repo + Aeropay client. Pins 100% of the driver payout-linking branches:
 *
 *   - startLink() opens a namespaced (`driver:<userId>`) hosted session.
 *   - getStatus() reports linked/unlinked and 404s a vanished driver.
 *   - applyBankLinked() persists the ref (looked up by user_id, written by
 *     driver.id), dedupes replays, relinks, tolerates an unknown driver, and
 *     raises on a mid-write vanish.
 *   - applyBankFailed() is a logged no-op.
 *   - the customer_ref namespacing helpers round-trip and reject non-driver
 *     refs.
 */
import { type Driver, type DriversRepository, type NewDriver } from '@dankdash/db';
import { NotFoundError, PaymentError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import {
  DriverBankLinkService,
  buildDriverCustomerRef,
  parseDriverCustomerRef,
} from './driver-bank-link.service.js';
import type { AeropayLinkSession } from '@dankdash/aeropay';
import type { AeropayClientLike } from './tokens.js';

const DRIVER_USER_ID = '01935f3d-0000-7000-8000-000000000801';
const DRIVER_ROW_ID = '01935f3d-0000-7000-8000-000000000901';
const RETURN_URL = 'https://dasher.dankdash.com/payouts/bank/return';

function makeDriver(overrides: Partial<Driver> = {}): Driver {
  // Only `id`, `userId`, and `aeropayAccountRef` are read/written by the
  // service; the rest is padded to satisfy the type.
  return {
    id: DRIVER_ROW_ID,
    userId: DRIVER_USER_ID,
    aeropayAccountRef: null,
    ...overrides,
  } as unknown as Driver;
}

class FakeDriversRepo {
  byUserId = new Map<string, Driver>();
  updateCalls: Array<{ id: string; patch: Partial<NewDriver> }> = [];
  returnNullOnUpdate = false;

  findByUserId = (userId: string): Promise<Driver | null> => {
    return Promise.resolve(this.byUserId.get(userId) ?? null);
  };

  update = (id: string, patch: Partial<NewDriver>): Promise<Driver | null> => {
    this.updateCalls.push({ id, patch });
    if (this.returnNullOnUpdate) return Promise.resolve(null);
    const row = [...this.byUserId.values()].find((d) => d.id === id);
    if (row === undefined) return Promise.resolve(null);
    const next = { ...row, ...patch } as Driver;
    this.byUserId.set(next.userId, next);
    return Promise.resolve(next);
  };
}

class FakeAeropayClient implements Pick<AeropayClientLike, 'linkBankAccount'> {
  linkCalls: Array<{ customerRef: string; returnUrl: string }> = [];
  nextLinkSession: AeropayLinkSession = {
    id: 'link_session_driver_1',
    hostedUrl: 'https://link.aeropay.com/session/driver_1',
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
  service: DriverBankLinkService;
  repo: FakeDriversRepo;
  aeropay: FakeAeropayClient;
} {
  const repo = new FakeDriversRepo();
  const aeropay = new FakeAeropayClient();
  const service = new DriverBankLinkService(
    repo as unknown as DriversRepository,
    aeropay as unknown as AeropayClientLike,
  );
  return { service, repo, aeropay };
}

describe('customer_ref namespacing helpers', () => {
  it('round-trips a driver user id through build/parse', () => {
    const ref = buildDriverCustomerRef(DRIVER_USER_ID);

    expect(ref).toBe(`driver:${DRIVER_USER_ID}`);
    expect(parseDriverCustomerRef(ref)).toBe(DRIVER_USER_ID);
  });

  it('returns null for a bare consumer ref (no prefix)', () => {
    expect(parseDriverCustomerRef(DRIVER_USER_ID)).toBeNull();
  });

  it('returns null for a dispensary ref', () => {
    expect(parseDriverCustomerRef(`dispensary:${DRIVER_USER_ID}`)).toBeNull();
  });

  it('returns null for the prefix with an empty id', () => {
    expect(parseDriverCustomerRef('driver:')).toBeNull();
  });
});

describe('DriverBankLinkService.startLink', () => {
  it('opens a hosted session with the namespaced customer_ref and returns the URL', async () => {
    const { service, aeropay } = build();

    const res = await service.startLink(DRIVER_USER_ID, RETURN_URL);

    expect(aeropay.linkCalls).toEqual([
      { customerRef: `driver:${DRIVER_USER_ID}`, returnUrl: RETURN_URL },
    ]);
    expect(res).toEqual({
      link: {
        id: 'link_session_driver_1',
        hostedUrl: 'https://link.aeropay.com/session/driver_1',
        expiresAt: '2026-05-01T03:00:00.000Z',
      },
    });
  });
});

describe('DriverBankLinkService.getStatus', () => {
  it('reports linked=false when no ref is on file', async () => {
    const { service, repo } = build();
    repo.byUserId.set(DRIVER_USER_ID, makeDriver({ aeropayAccountRef: null }));

    expect(await service.getStatus(DRIVER_USER_ID)).toEqual({ linked: false });
  });

  it('reports linked=true when a ref is on file', async () => {
    const { service, repo } = build();
    repo.byUserId.set(DRIVER_USER_ID, makeDriver({ aeropayAccountRef: 'ba_real_1' }));

    expect(await service.getStatus(DRIVER_USER_ID)).toEqual({ linked: true });
  });

  it('raises NotFoundError when the driver row is missing', async () => {
    const { service } = build();

    await expect(service.getStatus(DRIVER_USER_ID)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('DriverBankLinkService.applyBankLinked', () => {
  it('persists the confirmed bank-account id onto the driver (write keyed by driver.id)', async () => {
    const { service, repo } = build();
    repo.byUserId.set(DRIVER_USER_ID, makeDriver({ aeropayAccountRef: null }));

    await service.applyBankLinked(DRIVER_USER_ID, 'ba_real_1');

    expect(repo.updateCalls).toEqual([
      { id: DRIVER_ROW_ID, patch: { aeropayAccountRef: 'ba_real_1' } },
    ]);
    expect(repo.byUserId.get(DRIVER_USER_ID)?.aeropayAccountRef).toBe('ba_real_1');
  });

  it('is a no-op when the same account id is already on file (replay)', async () => {
    const { service, repo } = build();
    repo.byUserId.set(DRIVER_USER_ID, makeDriver({ aeropayAccountRef: 'ba_real_1' }));

    await service.applyBankLinked(DRIVER_USER_ID, 'ba_real_1');

    expect(repo.updateCalls).toHaveLength(0);
  });

  it('overwrites an existing ref on a relink to a different account', async () => {
    const { service, repo } = build();
    repo.byUserId.set(DRIVER_USER_ID, makeDriver({ aeropayAccountRef: 'ba_old' }));

    await service.applyBankLinked(DRIVER_USER_ID, 'ba_new');

    expect(repo.byUserId.get(DRIVER_USER_ID)?.aeropayAccountRef).toBe('ba_new');
  });

  it('is benign when the driver is unknown (no throw, no write)', async () => {
    const { service, repo } = build();

    await service.applyBankLinked(DRIVER_USER_ID, 'ba_real_1');

    expect(repo.updateCalls).toHaveLength(0);
  });

  it('raises PAYMENT_METHOD_INVALID when the row vanishes mid-write', async () => {
    const { service, repo } = build();
    repo.byUserId.set(DRIVER_USER_ID, makeDriver({ aeropayAccountRef: null }));
    repo.returnNullOnUpdate = true;

    await expect(service.applyBankLinked(DRIVER_USER_ID, 'ba_real_1')).rejects.toBeInstanceOf(
      PaymentError,
    );
  });
});

describe('DriverBankLinkService.applyBankFailed', () => {
  it('does not touch the driver row', () => {
    const { service, repo } = build();
    repo.byUserId.set(DRIVER_USER_ID, makeDriver({ aeropayAccountRef: 'ba_real_1' }));

    service.applyBankFailed(DRIVER_USER_ID);

    expect(repo.updateCalls).toHaveLength(0);
    expect(repo.byUserId.get(DRIVER_USER_ID)?.aeropayAccountRef).toBe('ba_real_1');
  });
});
