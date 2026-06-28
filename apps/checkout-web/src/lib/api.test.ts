import { describe, expect, it, vi } from 'vitest';
import { exchangeHandoff, getCart, placeCheckout, validateCart, type FetchLike } from './api.js';
import { CheckoutError } from './errors.js';

const BASE = 'http://api.test';

interface Call {
  url: string;
  init: RequestInit;
}

function recorder(response: Response): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return Promise.resolve(response);
  }) as unknown as FetchLike;
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const EXCHANGE_OK = {
  accessToken: 'a.b.c',
  tokenType: 'Bearer',
  expiresInSeconds: 900,
  cartId: '00000000-0000-0000-0000-0000000000c1',
  deliveryAddressId: '00000000-0000-0000-0000-0000000000a1',
};

describe('exchangeHandoff', () => {
  it('POSTs the token and parses the session', async () => {
    const { fetchImpl, calls } = recorder(json(EXCHANGE_OK));
    const result = await exchangeHandoff('handoff-jwt', { fetchImpl, baseUrl: BASE });

    expect(result.cartId).toBe(EXCHANGE_OK.cartId);
    expect(calls[0]?.url).toBe(`${BASE}/v1/auth/checkout-handoff/exchange`);
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ handoff: 'handoff-jwt' });
  });

  it('maps a non-2xx to EXCHANGE_FAILED with the status', async () => {
    const { fetchImpl } = recorder(
      json({ error: { code: 'TOKEN_REVOKED', message: 'used' } }, 401),
    );
    await expect(exchangeHandoff('x', { fetchImpl, baseUrl: BASE })).rejects.toMatchObject({
      code: 'EXCHANGE_FAILED',
      status: 401,
    });
  });

  it('maps a network failure to EXCHANGE_FAILED', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(new Error('ECONNREFUSED')),
    ) as unknown as FetchLike;
    await expect(exchangeHandoff('x', { fetchImpl, baseUrl: BASE })).rejects.toBeInstanceOf(
      CheckoutError,
    );
  });

  it('maps a schema-invalid body to BAD_RESPONSE', async () => {
    const { fetchImpl } = recorder(json({ accessToken: 'a.b.c' }));
    await expect(exchangeHandoff('x', { fetchImpl, baseUrl: BASE })).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });
  });
});

describe('getCart', () => {
  it('GETs the cart with the bearer token', async () => {
    const cart = {
      id: '00000000-0000-0000-0000-0000000000c1',
      userId: '00000000-0000-0000-0000-000000000011',
      dispensaryId: '00000000-0000-0000-0000-0000000000d1',
      items: [],
      subtotalCents: 0,
      expiresAt: '2026-06-28T18:00:00.000Z',
    };
    const { fetchImpl, calls } = recorder(json(cart));
    await getCart(cart.id, 'tok', { fetchImpl, baseUrl: BASE });

    expect(calls[0]?.url).toBe(`${BASE}/v1/carts/${cart.id}`);
    expect(calls[0]?.init.method).toBe('GET');
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
  });
});

describe('validateCart', () => {
  it('encodes the delivery address into the query string', async () => {
    const compliance = {
      passed: true,
      rules: [],
      cartTotals: { flowerGrams: 0, concentrateGrams: 0, edibleThcMg: 0 },
      limits: { flowerGramsMax: 56.7, concentrateGramsMax: 8, edibleThcMgMax: 800 },
      evaluatedAt: '2026-06-28T18:00:00.000Z',
      evaluationVersion: 'v1',
    };
    const { fetchImpl, calls } = recorder(json(compliance));
    await validateCart('cart1', 'addr-1', 'tok', { fetchImpl, baseUrl: BASE });

    expect(calls[0]?.url).toBe(`${BASE}/v1/carts/cart1/validate?deliveryAddressId=addr-1`);
    expect(calls[0]?.init.method).toBe('POST');
  });
});

describe('placeCheckout', () => {
  const order = {
    id: '00000000-0000-0000-0000-000000000001',
    shortCode: 'ABC123',
    status: 'placed',
    subtotalCents: 1000,
    cannabisTaxCents: 100,
    salesTaxCents: 80,
    deliveryFeeCents: 500,
    driverTipCents: 500,
    discountCents: 0,
    totalCents: 2180,
  };
  const resp = {
    order,
    paymentIntent: { provider: 'aeropay', status: 'initiated', amountCents: 2180 },
  };

  it('omits deliveryInstructions when empty', async () => {
    const { fetchImpl, calls } = recorder(json(resp, 201));
    await placeCheckout(
      'cart1',
      'tok',
      { deliveryAddressId: 'addr-1', driverTipCents: 500 },
      { fetchImpl, baseUrl: BASE },
    );
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toEqual({ deliveryAddressId: 'addr-1', driverTipCents: 500 });
    expect('deliveryInstructions' in body).toBe(false);
  });

  it('includes deliveryInstructions when provided', async () => {
    const { fetchImpl, calls } = recorder(json(resp, 201));
    await placeCheckout(
      'cart1',
      'tok',
      { deliveryAddressId: 'addr-1', driverTipCents: 500, deliveryInstructions: 'gate 4' },
      { fetchImpl, baseUrl: BASE },
    );
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body['deliveryInstructions']).toBe('gate 4');
  });

  it('maps a 422 to CHECKOUT_FAILED', async () => {
    const { fetchImpl } = recorder(
      json({ error: { code: 'COMPLIANCE_EVALUATION_FAILED', message: 'no' } }, 422),
    );
    await expect(
      placeCheckout(
        'cart1',
        'tok',
        { deliveryAddressId: 'addr-1', driverTipCents: 500 },
        { fetchImpl, baseUrl: BASE },
      ),
    ).rejects.toMatchObject({ code: 'CHECKOUT_FAILED', status: 422 });
  });
});
