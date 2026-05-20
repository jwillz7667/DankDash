import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from './client.js';
import {
  getVendorProductsAnalytics,
  getVendorSalesAnalytics,
  type ProductsAnalytics,
  type SalesAnalytics,
} from './vendor-analytics.js';

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

function captureRequest(input: RequestInfo | URL, init?: RequestInit): CapturedRequest {
  const url = typeof input === 'string' ? input : input.toString();
  const headers: Record<string, string> = {};
  const raw = init?.headers;
  if (raw instanceof Headers) {
    raw.forEach((value, key) => {
      headers[key] = value;
    });
  } else if (raw) {
    Object.assign(headers, raw as Record<string, string>);
  }
  return { url, method: init?.method ?? 'GET', headers };
}

function buildResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const DISPENSARY_ID = '01935f3d-0000-7000-8000-0000000000d1';

const SAMPLE_SALES: SalesAnalytics = {
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

const SAMPLE_PRODUCTS: ProductsAnalytics = {
  from: '2026-05-13T00:00:00.000Z',
  to: '2026-05-20T00:00:00.000Z',
  bestSellers: SAMPLE_SALES.topProducts,
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

function newClient(body: unknown): { client: ApiClient; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push(captureRequest(input, init));
    return buildResponse(200, body);
  });
  const client = new ApiClient({
    baseUrl: 'https://api.test',
    accessToken: 'access-1',
    dispensaryId: DISPENSARY_ID,
    fetchImpl,
  });
  return { client, captured };
}

describe('getVendorSalesAnalytics', () => {
  it('GETs /v1/vendor/analytics/sales with from/to query params', async () => {
    const { client, captured } = newClient(SAMPLE_SALES);

    const result = await getVendorSalesAnalytics(client, {
      from: '2026-05-13T00:00:00.000Z',
      to: '2026-05-20T00:00:00.000Z',
    });

    expect(result).toEqual(SAMPLE_SALES);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.method).toBe('GET');
    expect(captured[0]?.url).toBe(
      'https://api.test/v1/vendor/analytics/sales' +
        '?from=2026-05-13T00%3A00%3A00.000Z&to=2026-05-20T00%3A00%3A00.000Z',
    );
    expect(captured[0]?.headers['X-Dispensary-Id']).toBe(DISPENSARY_ID);
  });
});

describe('getVendorProductsAnalytics', () => {
  it('GETs /v1/vendor/analytics/products with from/to query params', async () => {
    const { client, captured } = newClient(SAMPLE_PRODUCTS);

    const result = await getVendorProductsAnalytics(client, {
      from: '2026-05-13T00:00:00.000Z',
      to: '2026-05-20T00:00:00.000Z',
    });

    expect(result).toEqual(SAMPLE_PRODUCTS);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.method).toBe('GET');
    expect(captured[0]?.url).toBe(
      'https://api.test/v1/vendor/analytics/products' +
        '?from=2026-05-13T00%3A00%3A00.000Z&to=2026-05-20T00%3A00%3A00.000Z',
    );
  });
});
