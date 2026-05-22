import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from './client.js';
import {
  acceptVendorOrder,
  getVendorOrder,
  listVendorQueue,
  markVendorOrderHandoff,
  markVendorOrderPrepped,
  markVendorOrderReady,
  rejectVendorOrder,
  type TransitionResponse,
  type VendorOrderDetail,
  type ListVendorQueueResult,
} from './vendor-orders.js';

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
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
  const body = typeof init?.body === 'string' ? init.body : null;
  return { url, method: init?.method ?? 'GET', headers, body };
}

function buildResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ORDER_ID = '01935f3d-0000-7000-8000-000000000001';
const DISPENSARY_ID = '01935f3d-0000-7000-8000-0000000000d1';
const TRANSITION_AT = '2026-05-19T12:00:00.000Z';

function newClient(handler: (req: CapturedRequest) => Response): {
  client: ApiClient;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = captureRequest(input, init);
    captured.push(req);
    return handler(req);
  });
  const client = new ApiClient({
    baseUrl: 'https://api.test',
    accessToken: 'access-1',
    dispensaryId: DISPENSARY_ID,
    fetchImpl,
  });
  return { client, captured };
}

describe('listVendorQueue', () => {
  it('GETs /v1/vendor/orders with no query when no params are supplied', async () => {
    const body: ListVendorQueueResult = { orders: [] };
    const { client, captured } = newClient(() => buildResponse(200, body));

    const result = await listVendorQueue(client);

    expect(result).toEqual(body);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe('https://api.test/v1/vendor/orders');
    expect(captured[0]?.method).toBe('GET');
  });

  it('serializes statuses as a comma-joined query parameter', async () => {
    const { client, captured } = newClient(() => buildResponse(200, { orders: [] }));

    await listVendorQueue(client, { statuses: ['placed', 'accepted', 'prepping'] });

    expect(captured[0]?.url).toBe(
      'https://api.test/v1/vendor/orders?statuses=placed%2Caccepted%2Cprepping',
    );
  });

  it('omits the statuses query when the array is empty (defers to the API default set)', async () => {
    const { client, captured } = newClient(() => buildResponse(200, { orders: [] }));

    await listVendorQueue(client, { statuses: [] });

    expect(captured[0]?.url).toBe('https://api.test/v1/vendor/orders');
  });

  it('forwards an explicit limit', async () => {
    const { client, captured } = newClient(() => buildResponse(200, { orders: [] }));

    await listVendorQueue(client, { limit: 50 });

    expect(captured[0]?.url).toBe('https://api.test/v1/vendor/orders?limit=50');
  });
});

describe('getVendorOrder', () => {
  it('GETs /v1/vendor/orders/:id with the id URI-encoded', async () => {
    const detail: VendorOrderDetail = {
      id: ORDER_ID,
      shortCode: 'A1B2',
      userId: '01935f3d-0000-7000-8000-000000000abc',
      dispensaryId: DISPENSARY_ID,
      driverId: null,
      status: 'placed',
      statusChangedAt: TRANSITION_AT,
      subtotalCents: 5400,
      cannabisTaxCents: 540,
      salesTaxCents: 270,
      deliveryFeeCents: 500,
      driverTipCents: 0,
      discountCents: 500,
      totalCents: 6210,
      timestamps: {
        placedAt: TRANSITION_AT,
        paymentFailedAt: null,
        acceptedAt: null,
        rejectedAt: null,
        preppingAt: null,
        preparedAt: null,
        awaitingDriverAt: null,
        dispatchFailedAt: null,
        driverAssignedAt: null,
        enRoutePickupAt: null,
        pickedUpAt: null,
        enRouteDropoffAt: null,
        arrivedAtDropoffAt: null,
        idScanPendingAt: null,
        deliveredAt: null,
        returnedToStoreAt: null,
        canceledAt: null,
        disputedAt: null,
        ratedAt: null,
      },
      ratings: { customer: null, review: null, dispensary: null, driver: null },
    };
    const { client, captured } = newClient(() => buildResponse(200, detail));

    const result = await getVendorOrder(client, ORDER_ID);

    expect(result).toEqual(detail);
    expect(captured[0]?.url).toBe(`https://api.test/v1/vendor/orders/${ORDER_ID}`);
    expect(captured[0]?.method).toBe('GET');
  });
});

describe('vendor order transition actions', () => {
  function transitionFixture(status: TransitionResponse['status']): TransitionResponse {
    return { id: ORDER_ID, status, statusChangedAt: TRANSITION_AT };
  }

  it('acceptVendorOrder POSTs to /:id/accept with no body', async () => {
    const fixture = transitionFixture('accepted');
    const { client, captured } = newClient(() => buildResponse(200, fixture));

    const result = await acceptVendorOrder(client, ORDER_ID);

    expect(result).toEqual(fixture);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.method).toBe('POST');
    expect(captured[0]?.url).toBe(`https://api.test/v1/vendor/orders/${ORDER_ID}/accept`);
    expect(captured[0]?.body).toBeNull();
    expect(captured[0]?.headers['Authorization']).toBe('Bearer access-1');
    expect(captured[0]?.headers['X-Dispensary-Id']).toBe(DISPENSARY_ID);
  });

  it('rejectVendorOrder POSTs to /:id/reject with a JSON {reason} body', async () => {
    const fixture = transitionFixture('rejected');
    const { client, captured } = newClient(() => buildResponse(200, fixture));

    const result = await rejectVendorOrder(client, ORDER_ID, 'Out of the SKU');

    expect(result).toEqual(fixture);
    expect(captured[0]?.method).toBe('POST');
    expect(captured[0]?.url).toBe(`https://api.test/v1/vendor/orders/${ORDER_ID}/reject`);
    expect(captured[0]?.headers['Content-Type']).toBe('application/json');
    expect(captured[0]?.body).toBe('{"reason":"Out of the SKU"}');
  });

  it('markVendorOrderPrepped POSTs to /:id/prepped with no body', async () => {
    const fixture = transitionFixture('prepping');
    const { client, captured } = newClient(() => buildResponse(200, fixture));

    const result = await markVendorOrderPrepped(client, ORDER_ID);

    expect(result).toEqual(fixture);
    expect(captured[0]?.method).toBe('POST');
    expect(captured[0]?.url).toBe(`https://api.test/v1/vendor/orders/${ORDER_ID}/prepped`);
    expect(captured[0]?.body).toBeNull();
  });

  it('markVendorOrderReady POSTs to /:id/ready with no body', async () => {
    const fixture = transitionFixture('ready_for_pickup');
    const { client, captured } = newClient(() => buildResponse(200, fixture));

    const result = await markVendorOrderReady(client, ORDER_ID);

    expect(result).toEqual(fixture);
    expect(captured[0]?.method).toBe('POST');
    expect(captured[0]?.url).toBe(`https://api.test/v1/vendor/orders/${ORDER_ID}/ready`);
    expect(captured[0]?.body).toBeNull();
  });

  it('markVendorOrderHandoff POSTs to /:id/handoff with no body', async () => {
    const fixture = transitionFixture('picked_up');
    const { client, captured } = newClient(() => buildResponse(200, fixture));

    const result = await markVendorOrderHandoff(client, ORDER_ID);

    expect(result).toEqual(fixture);
    expect(captured[0]?.method).toBe('POST');
    expect(captured[0]?.url).toBe(`https://api.test/v1/vendor/orders/${ORDER_ID}/handoff`);
    expect(captured[0]?.body).toBeNull();
  });

  it('URI-encodes the order id so a malformed id cannot break path parsing', async () => {
    // The API uses ParseUUIDPipe so a non-UUID will be rejected server-side
    // — but the client must still encode the segment so we never produce a
    // URL with a raw "/" or "?" injected by an upstream bug.
    const messyId = 'not/a real uuid?nope';
    const { client, captured } = newClient(() => buildResponse(200, transitionFixture('accepted')));

    await acceptVendorOrder(client, messyId);

    expect(captured[0]?.url).toBe(
      `https://api.test/v1/vendor/orders/${encodeURIComponent(messyId)}/accept`,
    );
  });

  it('propagates ApiError from the transport on non-2xx responses', async () => {
    const { client } = newClient(() =>
      buildResponse(409, {
        error: { code: 'INVALID_TRANSITION', message: 'order is already accepted', details: {} },
      }),
    );

    await expect(acceptVendorOrder(client, ORDER_ID)).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      code: 'INVALID_TRANSITION',
    });
  });
});
