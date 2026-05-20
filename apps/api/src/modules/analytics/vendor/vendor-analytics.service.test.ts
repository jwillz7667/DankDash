/**
 * Unit tests for `VendorAnalyticsService`. Treats the repository as a fake
 * so the assertions can target the projection + window math:
 *
 *   - half-open window math: previous-period boundaries are
 *     [from - (to-from), from) and the prior-period repo call gets the
 *     shifted bounds.
 *   - avg-order math: zero orders -> zero AOV (no divide-by-zero leak).
 *   - reorder rate clamp: zero customers -> rate 0, not NaN.
 *   - dead-inventory days-since-last-sale: `Math.floor` against the
 *     window's `to` boundary; null when the listing has never sold.
 *   - dispensary scoping: every fake call captures the dispensary id.
 *
 * The service is a thin projection layer; these tests pin its
 * arithmetic so future query changes that touch the same fields don't
 * accidentally regress the API surface.
 */
import type {
  DeadInventoryRow,
  HourlyBucketRow,
  ReorderCountsRow,
  SalesAggregateRow,
  TopProductRow,
} from '@dankdash/db';
import { describe, expect, it } from 'vitest';
import { VendorAnalyticsService, type AnalyticsRepoFactory } from './vendor-analytics.service.js';
import type { VendorContext } from '../../listings/vendor/vendor-context.types.js';

const CTX: VendorContext = {
  userId: '01935f3d-0000-7000-8000-0000000000a1',
  dispensaryId: '01935f3d-0000-7000-8000-0000000000d1',
  staffRole: 'manager',
  staffMemberId: '01935f3d-0000-7000-8000-0000000000a2',
};

interface RepoCall {
  readonly fn: string;
  readonly dispensaryId: string;
  readonly since: Date;
  readonly until: Date;
}

class FakeAnalyticsRepo {
  readonly calls: RepoCall[] = [];
  salesByCall: SalesAggregateRow[] = [
    { revenueCents: 0, orderCount: 0 },
    { revenueCents: 0, orderCount: 0 },
  ];
  hourly: HourlyBucketRow[] = [];
  topProducts: TopProductRow[] = [];
  reorder: ReorderCountsRow = { customerCount: 0, repeatCustomerCount: 0 };
  deadInventory: DeadInventoryRow[] = [];

  private salesIdx = 0;

  async dispensarySalesBetween(
    dispensaryId: string,
    since: Date,
    until: Date,
  ): Promise<SalesAggregateRow> {
    this.calls.push({ fn: 'sales', dispensaryId, since, until });
    const row = this.salesByCall[this.salesIdx] ?? { revenueCents: 0, orderCount: 0 };
    this.salesIdx += 1;
    return row;
  }

  async dispensaryHourlyBetween(
    dispensaryId: string,
    since: Date,
    until: Date,
  ): Promise<readonly HourlyBucketRow[]> {
    this.calls.push({ fn: 'hourly', dispensaryId, since, until });
    return this.hourly;
  }

  async dispensaryTopProductsBetween(
    dispensaryId: string,
    since: Date,
    until: Date,
  ): Promise<readonly TopProductRow[]> {
    this.calls.push({ fn: 'top', dispensaryId, since, until });
    return this.topProducts;
  }

  async dispensaryReorderBetween(
    dispensaryId: string,
    since: Date,
    until: Date,
  ): Promise<ReorderCountsRow> {
    this.calls.push({ fn: 'reorder', dispensaryId, since, until });
    return this.reorder;
  }

  async dispensaryDeadInventory(
    dispensaryId: string,
    since: Date,
    until: Date,
  ): Promise<readonly DeadInventoryRow[]> {
    this.calls.push({ fn: 'dead', dispensaryId, since, until });
    return this.deadInventory;
  }
}

function buildService(repo: FakeAnalyticsRepo): VendorAnalyticsService {
  // The service expects an `AnalyticsRepoFactory` that returns an instance
  // structurally matching the real `AnalyticsRepository`. The fake exposes
  // the same methods with the same shapes; cast through unknown so the
  // structural mismatch (no Drizzle Database in the fake) doesn't trip
  // strict-null-checks for fields the service never reads.
  const factory: AnalyticsRepoFactory = () => repo as unknown as ReturnType<AnalyticsRepoFactory>;
  return new VendorAnalyticsService(factory);
}

describe('VendorAnalyticsService.sales', () => {
  it('issues current+previous sales queries against shifted windows', async () => {
    const repo = new FakeAnalyticsRepo();
    repo.salesByCall = [
      { revenueCents: 100_000, orderCount: 10 },
      { revenueCents: 80_000, orderCount: 8 },
    ];
    const svc = buildService(repo);

    const from = '2026-05-13T00:00:00.000Z';
    const to = '2026-05-20T00:00:00.000Z';
    const result = await svc.sales(CTX, { from, to });

    const salesCalls = repo.calls.filter((c) => c.fn === 'sales');
    expect(salesCalls).toHaveLength(2);
    expect(salesCalls[0]?.since.toISOString()).toBe(from);
    expect(salesCalls[0]?.until.toISOString()).toBe(to);
    // 7 days backwards => 2026-05-06 .. 2026-05-13
    expect(salesCalls[1]?.since.toISOString()).toBe('2026-05-06T00:00:00.000Z');
    expect(salesCalls[1]?.until.toISOString()).toBe(from);

    expect(result.revenueCents).toBe(100_000);
    expect(result.previousRevenueCents).toBe(80_000);
    expect(result.avgOrderValueCents).toBe(10_000);
    expect(result.previousAvgOrderValueCents).toBe(10_000);
  });

  it('returns 0 AOV when current period has zero orders', async () => {
    const repo = new FakeAnalyticsRepo();
    repo.salesByCall = [
      { revenueCents: 0, orderCount: 0 },
      { revenueCents: 50_000, orderCount: 5 },
    ];
    const svc = buildService(repo);

    const result = await svc.sales(CTX, {
      from: '2026-05-13T00:00:00.000Z',
      to: '2026-05-20T00:00:00.000Z',
    });

    expect(result.orderCount).toBe(0);
    expect(result.avgOrderValueCents).toBe(0);
    expect(result.previousAvgOrderValueCents).toBe(10_000);
  });

  it('truncates fractional AOV to integer cents', async () => {
    const repo = new FakeAnalyticsRepo();
    repo.salesByCall = [
      { revenueCents: 12_345, orderCount: 7 }, // 1763.57…
      { revenueCents: 0, orderCount: 0 },
    ];
    const svc = buildService(repo);

    const result = await svc.sales(CTX, {
      from: '2026-05-13T00:00:00.000Z',
      to: '2026-05-20T00:00:00.000Z',
    });

    expect(result.avgOrderValueCents).toBe(1_763);
  });

  it('passes the hourly + top-products buckets through unchanged', async () => {
    const repo = new FakeAnalyticsRepo();
    repo.hourly = [
      { dayOfWeek: 5, hour: 19, orderCount: 4, revenueCents: 32_000 },
      { dayOfWeek: 6, hour: 12, orderCount: 7, revenueCents: 54_500 },
    ];
    repo.topProducts = [
      {
        productId: '01935f3d-0000-7000-8000-0000000000f1',
        brand: 'North Star',
        name: 'Pineapple Express 3.5g',
        unitsSold: 12,
        revenueCents: 54_000,
      },
    ];
    const svc = buildService(repo);

    const result = await svc.sales(CTX, {
      from: '2026-05-13T00:00:00.000Z',
      to: '2026-05-20T00:00:00.000Z',
    });

    expect(result.hourly).toEqual(repo.hourly);
    expect(result.topProducts).toEqual(repo.topProducts);
  });
});

describe('VendorAnalyticsService.products', () => {
  it('returns best sellers + reorder rate within [0,1] with 4-dp rounding', async () => {
    const repo = new FakeAnalyticsRepo();
    repo.topProducts = [
      {
        productId: '01935f3d-0000-7000-8000-0000000000f1',
        brand: 'North Star',
        name: 'Pineapple Express',
        unitsSold: 99,
        revenueCents: 445_500,
      },
    ];
    repo.reorder = { customerCount: 600, repeatCustomerCount: 193 }; // 0.32166…
    const svc = buildService(repo);

    const result = await svc.products(CTX, {
      from: '2026-05-13T00:00:00.000Z',
      to: '2026-05-20T00:00:00.000Z',
    });

    expect(result.bestSellers).toEqual(repo.topProducts);
    expect(result.reorderRate.customerCount).toBe(600);
    expect(result.reorderRate.repeatCustomerCount).toBe(193);
    expect(result.reorderRate.rate).toBe(0.3217);
  });

  it('clamps reorder rate to 0 when no customers ordered', async () => {
    const repo = new FakeAnalyticsRepo();
    repo.reorder = { customerCount: 0, repeatCustomerCount: 0 };
    const svc = buildService(repo);

    const result = await svc.products(CTX, {
      from: '2026-05-13T00:00:00.000Z',
      to: '2026-05-20T00:00:00.000Z',
    });

    expect(result.reorderRate.rate).toBe(0);
  });

  it('derives daysSinceLastSale via floor against window `to`', async () => {
    const repo = new FakeAnalyticsRepo();
    // window ends 2026-05-20T00:00:00Z; lastSoldAt 6 days + 12h earlier ==>
    // 6 days floor.
    repo.deadInventory = [
      {
        listingId: '01935f3d-0000-7000-8000-0000000000e1',
        sku: 'NS-PE-3.5G',
        brand: 'North Star',
        name: 'Pineapple Express',
        quantityAvailable: 8,
        priceCents: 4500,
        lastSoldAt: new Date('2026-05-13T12:00:00.000Z'),
      },
      // never sold
      {
        listingId: '01935f3d-0000-7000-8000-0000000000e2',
        sku: 'GF-OG-1G',
        brand: 'Goodfellas',
        name: 'OG Kush 1g',
        quantityAvailable: 2,
        priceCents: 1500,
        lastSoldAt: null,
      },
    ];
    const svc = buildService(repo);

    const result = await svc.products(CTX, {
      from: '2026-05-13T00:00:00.000Z',
      to: '2026-05-20T00:00:00.000Z',
    });

    expect(result.deadInventory).toHaveLength(2);
    expect(result.deadInventory[0]?.daysSinceLastSale).toBe(6);
    expect(result.deadInventory[1]?.daysSinceLastSale).toBeNull();
  });

  it('forwards the dispensary id from the vendor context to every repo call', async () => {
    const repo = new FakeAnalyticsRepo();
    const svc = buildService(repo);

    await svc.products(CTX, {
      from: '2026-05-13T00:00:00.000Z',
      to: '2026-05-20T00:00:00.000Z',
    });

    for (const call of repo.calls) {
      expect(call.dispensaryId).toBe(CTX.dispensaryId);
    }
  });
});
