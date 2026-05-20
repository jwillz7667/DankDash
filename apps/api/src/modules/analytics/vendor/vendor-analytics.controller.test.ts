/**
 * Unit tests for VendorAnalyticsController.
 *
 * Controller owns route-param plumbing and response shape. Auth wiring
 * (VendorContextGuard + RolesGuard) is verified at the module
 * composition level; here we exercise that the controller threads
 * `@CurrentDispensary() ctx` and `@Query` verbatim to the service.
 */
import { describe, expect, it } from 'vitest';
import { VendorAnalyticsController } from './vendor-analytics.controller.js';
import type {
  ProductsAnalyticsQuery,
  ProductsAnalyticsResponse,
  SalesAnalyticsQuery,
  SalesAnalyticsResponse,
} from './dto/index.js';
import type { VendorContext } from '../../listings/vendor/vendor-context.types.js';
import type { VendorAnalyticsService } from './vendor-analytics.service.js';

const CTX: VendorContext = {
  dispensaryId: '01935f3d-0000-7000-8000-0000000000d1',
  userId: '01935f3d-0000-7000-8000-0000000000a1',
  staffRole: 'manager',
  staffMemberId: '01935f3d-0000-7000-8000-0000000000a2',
};

const SALES_RESPONSE: SalesAnalyticsResponse = {
  from: '2026-05-13T00:00:00.000Z',
  to: '2026-05-20T00:00:00.000Z',
  revenueCents: 250_000,
  previousRevenueCents: 200_000,
  orderCount: 50,
  previousOrderCount: 42,
  avgOrderValueCents: 5_000,
  previousAvgOrderValueCents: 4_762,
  hourly: [{ dayOfWeek: 5, hour: 19, orderCount: 4, revenueCents: 32_000 }],
  topProducts: [
    {
      productId: '01935f3d-0000-7000-8000-0000000000f1',
      brand: 'North Star',
      name: 'Pineapple Express',
      unitsSold: 12,
      revenueCents: 54_000,
    },
  ],
};

const PRODUCTS_RESPONSE: ProductsAnalyticsResponse = {
  from: '2026-05-13T00:00:00.000Z',
  to: '2026-05-20T00:00:00.000Z',
  bestSellers: SALES_RESPONSE.topProducts,
  deadInventory: [
    {
      listingId: '01935f3d-0000-7000-8000-0000000000e1',
      sku: 'NS-PE-3.5G',
      brand: 'North Star',
      name: 'Pineapple Express',
      quantityAvailable: 8,
      priceCents: 4500,
      daysSinceLastSale: 12,
    },
  ],
  reorderRate: { customerCount: 600, repeatCustomerCount: 193, rate: 0.3217 },
};

class FakeVendorAnalyticsService {
  public salesCalls: { ctx: VendorContext; query: SalesAnalyticsQuery }[] = [];
  public productsCalls: { ctx: VendorContext; query: ProductsAnalyticsQuery }[] = [];

  sales = (ctx: VendorContext, query: SalesAnalyticsQuery): Promise<SalesAnalyticsResponse> => {
    this.salesCalls.push({ ctx, query });
    return Promise.resolve(SALES_RESPONSE);
  };

  products = (
    ctx: VendorContext,
    query: ProductsAnalyticsQuery,
  ): Promise<ProductsAnalyticsResponse> => {
    this.productsCalls.push({ ctx, query });
    return Promise.resolve(PRODUCTS_RESPONSE);
  };
}

describe('VendorAnalyticsController.sales', () => {
  it('forwards (ctx, query) and returns the sales response', async () => {
    const svc = new FakeVendorAnalyticsService();
    const controller = new VendorAnalyticsController(svc as unknown as VendorAnalyticsService);

    const query: SalesAnalyticsQuery = {
      from: '2026-05-13T00:00:00.000Z',
      to: '2026-05-20T00:00:00.000Z',
    };
    const res = await controller.sales(CTX, query);

    expect(svc.salesCalls).toEqual([{ ctx: CTX, query }]);
    expect(res).toEqual(SALES_RESPONSE);
  });
});

describe('VendorAnalyticsController.products', () => {
  it('forwards (ctx, query) and returns the products response', async () => {
    const svc = new FakeVendorAnalyticsService();
    const controller = new VendorAnalyticsController(svc as unknown as VendorAnalyticsService);

    const query: ProductsAnalyticsQuery = {
      from: '2026-05-13T00:00:00.000Z',
      to: '2026-05-20T00:00:00.000Z',
    };
    const res = await controller.products(CTX, query);

    expect(svc.productsCalls).toEqual([{ ctx: CTX, query }]);
    expect(res).toEqual(PRODUCTS_RESPONSE);
  });
});
