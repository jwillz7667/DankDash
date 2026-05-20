/**
 * VendorPayoutsService unit tests.
 *
 * The service is a small projection over PayoutsRepository +
 * OrdersRepository — but it owns the cross-tenant 404 guard, the
 * period-string → UTC arithmetic that bounds the constituent-orders
 * query, and the wire-shape mapping (Date → ISO string, etc.). Each of
 * those gets its own test against in-memory fakes.
 */
import {
  type OrdersRepository,
  type Payout,
  type PayoutsRepository,
  type VendorPayoutOrderRow,
} from '@dankdash/db';
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { VendorPayoutsService } from './vendor-payouts.service.js';
import type { VendorContext } from '../../listings/vendor/vendor-context.types.js';

const CTX: VendorContext = {
  dispensaryId: '01935f3d-0000-7000-8000-0000000000d1',
  userId: '01935f3d-0000-7000-8000-0000000000a1',
  staffRole: 'manager',
  staffMemberId: '01935f3d-0000-7000-8000-0000000000a2',
};

const PAYOUT_ID = '01935f3d-0000-7000-8000-0000000000b1';
const OTHER_DISP_ID = '01935f3d-0000-7000-8000-0000000000d2';
const PRIOR_PAYOUT_ID = '01935f3d-0000-7000-8000-0000000000b2';

function makePayout(overrides: Partial<Payout> = {}): Payout {
  const base: Payout = {
    id: PAYOUT_ID,
    recipientType: 'dispensary',
    recipientId: CTX.dispensaryId,
    periodStart: '2026-05-17',
    periodEnd: '2026-05-18',
    grossCents: 125_000,
    feesCents: 1_500,
    netCents: 123_500,
    aeropayPayoutRef: 'aero_payout_123',
    status: 'completed',
    scheduledFor: '2026-05-18',
    initiatedAt: new Date('2026-05-18T08:00:00.000Z'),
    completedAt: new Date('2026-05-18T08:15:00.000Z'),
    failureReason: null,
    createdAt: new Date('2026-05-18T08:00:00.000Z'),
    updatedAt: new Date('2026-05-18T08:15:00.000Z'),
  };
  return { ...base, ...overrides };
}

function makeOrderRow(overrides: Partial<VendorPayoutOrderRow> = {}): VendorPayoutOrderRow {
  const base: VendorPayoutOrderRow = {
    id: '01935f3d-0000-7000-8000-0000000000c1',
    shortCode: 'DD-A4F2-19',
    deliveredAt: new Date('2026-05-17T22:13:00.000Z'),
    subtotalCents: 4500,
    totalCents: 5000,
    discountCents: 0,
    customerFirstName: 'Jane',
    customerLastName: 'Doe',
  };
  return { ...base, ...overrides };
}

class FakePayoutsRepository {
  public listForRecipientCalls: {
    readonly recipientType: string;
    readonly recipientId: string;
    readonly limit?: number;
  }[] = [];
  public findByIdCalls: string[] = [];
  public payoutsByRecipient: readonly Payout[] = [];
  public payoutsById = new Map<string, Payout>();

  listForRecipient = (
    recipientType: string,
    recipientId: string,
    limit?: number,
  ): Promise<readonly Payout[]> => {
    this.listForRecipientCalls.push({
      recipientType,
      recipientId,
      ...(limit !== undefined ? { limit } : {}),
    });
    return Promise.resolve(
      this.payoutsByRecipient.filter(
        (p) => p.recipientType === recipientType && p.recipientId === recipientId,
      ),
    );
  };

  findById = (id: string): Promise<Payout | null> => {
    this.findByIdCalls.push(id);
    return Promise.resolve(this.payoutsById.get(id) ?? null);
  };
}

class FakeOrdersRepository {
  public listCalls: {
    readonly dispensaryId: string;
    readonly from: Date;
    readonly to: Date;
    readonly limit?: number;
  }[] = [];
  public rows: readonly VendorPayoutOrderRow[] = [];

  listDeliveredForDispensaryBetween = (
    dispensaryId: string,
    from: Date,
    to: Date,
    limit?: number,
  ): Promise<readonly VendorPayoutOrderRow[]> => {
    this.listCalls.push({
      dispensaryId,
      from,
      to,
      ...(limit !== undefined ? { limit } : {}),
    });
    return Promise.resolve(this.rows);
  };
}

function makeService(): {
  service: VendorPayoutsService;
  payouts: FakePayoutsRepository;
  orders: FakeOrdersRepository;
} {
  const payouts = new FakePayoutsRepository();
  const orders = new FakeOrdersRepository();
  const service = new VendorPayoutsService(() => ({
    // The repo factory pattern lets us swap in fakes that satisfy the
    // narrow interface the service consumes. The shape matches the real
    // repos' method signatures used in the service.
    payouts: payouts as unknown as PayoutsRepository,
    orders: orders as unknown as OrdersRepository,
  }));
  return { service, payouts, orders };
}

describe('VendorPayoutsService.list', () => {
  it("returns the active vendor's payouts mapped to summary shape with cap 50", async () => {
    const { service, payouts } = makeService();
    payouts.payoutsByRecipient = [
      makePayout({ id: PAYOUT_ID }),
      makePayout({ id: PRIOR_PAYOUT_ID, periodStart: '2026-05-16', periodEnd: '2026-05-17' }),
    ];

    const result = await service.list(CTX);

    expect(payouts.listForRecipientCalls).toEqual([
      { recipientType: 'dispensary', recipientId: CTX.dispensaryId, limit: 50 },
    ]);
    expect(result.payouts).toHaveLength(2);
    expect(result.payouts[0]).toMatchObject({
      id: PAYOUT_ID,
      periodStart: '2026-05-17',
      periodEnd: '2026-05-18',
      grossCents: 125_000,
      feesCents: 1_500,
      netCents: 123_500,
      status: 'completed',
      aeropayPayoutRef: 'aero_payout_123',
      initiatedAt: '2026-05-18T08:00:00.000Z',
      completedAt: '2026-05-18T08:15:00.000Z',
      failureReason: null,
    });
  });

  it('returns empty list when the vendor has no payouts yet', async () => {
    const { service, payouts } = makeService();
    payouts.payoutsByRecipient = [];

    const result = await service.list(CTX);

    expect(result.payouts).toEqual([]);
  });

  it('emits null for unset timestamp columns (pending payout)', async () => {
    const { service, payouts } = makeService();
    payouts.payoutsByRecipient = [
      makePayout({
        status: 'pending',
        initiatedAt: null,
        completedAt: null,
        aeropayPayoutRef: null,
      }),
    ];

    const result = await service.list(CTX);

    expect(result.payouts[0]).toMatchObject({
      status: 'pending',
      initiatedAt: null,
      completedAt: null,
      aeropayPayoutRef: null,
    });
  });
});

describe('VendorPayoutsService.findById', () => {
  it('returns the payout summary + constituent orders inside the period', async () => {
    const { service, payouts, orders } = makeService();
    const payout = makePayout();
    payouts.payoutsById.set(PAYOUT_ID, payout);
    orders.rows = [
      makeOrderRow({ id: '01935f3d-0000-7000-8000-0000000000c1', shortCode: 'DD-AAAA-01' }),
      makeOrderRow({
        id: '01935f3d-0000-7000-8000-0000000000c2',
        shortCode: 'DD-BBBB-02',
        totalCents: 8200,
        deliveredAt: new Date('2026-05-17T16:45:00.000Z'),
      }),
    ];

    const result = await service.findById(CTX, PAYOUT_ID);

    expect(result.id).toBe(PAYOUT_ID);
    expect(result.orders).toHaveLength(2);
    expect(result.orders[0]).toMatchObject({
      id: '01935f3d-0000-7000-8000-0000000000c1',
      shortCode: 'DD-AAAA-01',
      deliveredAt: '2026-05-17T22:13:00.000Z',
      totalCents: 5000,
      customerFirstName: 'Jane',
      customerLastName: 'Doe',
    });
    // 2026-05-17 in America/Chicago is CDT (UTC-5), so the Central
    // midnight boundaries map to 05:00 UTC on each calendar day.
    expect(orders.listCalls).toEqual([
      {
        dispensaryId: CTX.dispensaryId,
        from: new Date('2026-05-17T05:00:00.000Z'),
        to: new Date('2026-05-18T05:00:00.000Z'),
        limit: 500,
      },
    ]);
  });

  it('throws NotFound when the payout does not exist', async () => {
    const { service } = makeService();
    await expect(service.findById(CTX, PAYOUT_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFound (not 403) when the payout belongs to another dispensary', async () => {
    const { service, payouts } = makeService();
    payouts.payoutsById.set(PAYOUT_ID, makePayout({ recipientId: OTHER_DISP_ID }));

    await expect(service.findById(CTX, PAYOUT_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFound when the payout recipient is a driver, not the dispensary', async () => {
    const { service, payouts } = makeService();
    payouts.payoutsById.set(PAYOUT_ID, makePayout({ recipientType: 'driver' }));

    await expect(service.findById(CTX, PAYOUT_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns the payout with an empty orders list when no orders fell in the window', async () => {
    const { service, payouts, orders } = makeService();
    payouts.payoutsById.set(PAYOUT_ID, makePayout());
    orders.rows = [];

    const result = await service.findById(CTX, PAYOUT_ID);

    expect(result.id).toBe(PAYOUT_ID);
    expect(result.orders).toEqual([]);
  });

  it('handles the DST spring-forward day (2026-03-08) — Central midnights both UTC-6 → UTC-5', async () => {
    const { service, payouts, orders } = makeService();
    payouts.payoutsById.set(
      PAYOUT_ID,
      makePayout({ periodStart: '2026-03-08', periodEnd: '2026-03-09' }),
    );

    await service.findById(CTX, PAYOUT_ID);

    // 2026-03-08 00:00 CST is 06:00 UTC; 2026-03-09 00:00 CDT is 05:00 UTC.
    expect(orders.listCalls[0]?.from).toEqual(new Date('2026-03-08T06:00:00.000Z'));
    expect(orders.listCalls[0]?.to).toEqual(new Date('2026-03-09T05:00:00.000Z'));
  });
});
