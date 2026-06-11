/**
 * DTO schema tests for the checkout module.
 *
 * The request schema is the boundary between user input and the service:
 * it must reject any extra key (probe vector), reject malformed UUIDs,
 * enforce the mandatory driver tip ($2 floor, $500 cap), trim and clamp
 * delivery instructions, and accept the minimal happy-path body.
 *
 * The response schema (server → client contract) is checked positively
 * with a representative successful payload so a future schema-tightening
 * cannot silently break the iOS client without breaking the test.
 */
import { describe, expect, it } from 'vitest';
import {
  CheckoutRequestSchema,
  CheckoutResponseSchema,
  MAX_DELIVERY_INSTRUCTIONS_LENGTH,
  MAX_DRIVER_TIP_CENTS,
  MIN_DRIVER_TIP_CENTS,
  OrderStatusSchema,
  PaymentIntentResponseSchema,
} from './index.js';

const ADDRESS_ID = '01935f3d-0000-7000-8000-000000000060';
const PAYMENT_METHOD_ID = '01935f3d-0000-7000-8000-000000000070';
const ORDER_ID = '01935f3d-0000-7000-8000-000000001000';
const ITEM_ID = '01935f3d-0000-7000-8000-000000002000';
const PAYMENT_INTENT_ID = '01935f3d-0000-7000-8000-000000004000';
const LISTING_ID = '01935f3d-0000-7000-8000-000000000030';
const USER_ID = '01935f3d-0000-7000-8000-000000000001';
const DISPENSARY_ID = '01935f3d-0000-7000-8000-000000000010';

describe('CheckoutRequestSchema', () => {
  it('accepts the minimal valid body (address + tip at the floor)', () => {
    const parsed = CheckoutRequestSchema.parse({
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: MIN_DRIVER_TIP_CENTS,
    });

    expect(parsed.deliveryAddressId).toBe(ADDRESS_ID);
    expect(parsed.driverTipCents).toBe(MIN_DRIVER_TIP_CENTS);
    expect(parsed.paymentMethodId).toBeUndefined();
    expect(parsed.deliveryInstructions).toBeUndefined();
  });

  it('rejects a body without driverTipCents (the tip is mandatory, no default)', () => {
    expect(() => CheckoutRequestSchema.parse({ deliveryAddressId: ADDRESS_ID })).toThrow();
  });

  it('rejects driverTipCents below the $2 floor', () => {
    expect(() =>
      CheckoutRequestSchema.parse({
        deliveryAddressId: ADDRESS_ID,
        driverTipCents: MIN_DRIVER_TIP_CENTS - 1,
      }),
    ).toThrow();
  });

  it('accepts a full body with paymentMethodId, tip, and instructions', () => {
    const parsed = CheckoutRequestSchema.parse({
      deliveryAddressId: ADDRESS_ID,
      paymentMethodId: PAYMENT_METHOD_ID,
      driverTipCents: 500,
      deliveryInstructions: '  Leave at the door  ',
    });

    expect(parsed.paymentMethodId).toBe(PAYMENT_METHOD_ID);
    expect(parsed.driverTipCents).toBe(500);
    expect(parsed.deliveryInstructions).toBe('Leave at the door');
  });

  it('rejects a non-UUID deliveryAddressId', () => {
    expect(() => CheckoutRequestSchema.parse({ deliveryAddressId: 'not-a-uuid' })).toThrow();
  });

  it('rejects a non-UUID paymentMethodId', () => {
    expect(() =>
      CheckoutRequestSchema.parse({
        deliveryAddressId: ADDRESS_ID,
        paymentMethodId: 'not-a-uuid',
      }),
    ).toThrow();
  });

  it('rejects a negative driverTipCents', () => {
    expect(() =>
      CheckoutRequestSchema.parse({
        deliveryAddressId: ADDRESS_ID,
        driverTipCents: -1,
      }),
    ).toThrow();
  });

  it('rejects a non-integer driverTipCents', () => {
    expect(() =>
      CheckoutRequestSchema.parse({
        deliveryAddressId: ADDRESS_ID,
        driverTipCents: 12.5,
      }),
    ).toThrow();
  });

  it('rejects driverTipCents above the $500 cap', () => {
    expect(() =>
      CheckoutRequestSchema.parse({
        deliveryAddressId: ADDRESS_ID,
        driverTipCents: MAX_DRIVER_TIP_CENTS + 1,
      }),
    ).toThrow();
  });

  it('accepts driverTipCents exactly at the cap', () => {
    const parsed = CheckoutRequestSchema.parse({
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: MAX_DRIVER_TIP_CENTS,
    });
    expect(parsed.driverTipCents).toBe(MAX_DRIVER_TIP_CENTS);
  });

  it('rejects deliveryInstructions over 500 characters (post-trim)', () => {
    expect(() =>
      CheckoutRequestSchema.parse({
        deliveryAddressId: ADDRESS_ID,
        deliveryInstructions: 'x'.repeat(MAX_DELIVERY_INSTRUCTIONS_LENGTH + 1),
      }),
    ).toThrow();
  });

  it('rejects unknown keys (strict)', () => {
    // `parse` accepts `unknown`; the strict() rejection is a runtime
    // check, not a compile-time one — which is exactly what we want for a
    // body coming off the wire.
    const probe: unknown = {
      deliveryAddressId: ADDRESS_ID,
      secretField: 'value',
    };
    expect(() => CheckoutRequestSchema.parse(probe)).toThrow();
  });
});

describe('OrderStatusSchema', () => {
  it.each([
    'placed',
    'payment_failed',
    'accepted',
    'rejected',
    'prepping',
    'ready_for_pickup',
    'awaiting_driver',
    'dispatch_failed',
    'driver_assigned',
    'en_route_pickup',
    'picked_up',
    'en_route_dropoff',
    'arrived_at_dropoff',
    'id_scan_pending',
    'id_scan_passed',
    'id_scan_failed',
    'delivered',
    'returned_to_store',
    'canceled',
    'disputed',
  ] as const)('accepts %s', (status) => {
    expect(OrderStatusSchema.parse(status)).toBe(status);
  });

  it('rejects an unknown status', () => {
    expect(() => OrderStatusSchema.parse('teleported')).toThrow();
  });
});

describe('PaymentIntentResponseSchema', () => {
  it('accepts the Phase 5 aeropay stub shape with null clientSecret', () => {
    const parsed = PaymentIntentResponseSchema.parse({
      id: PAYMENT_INTENT_ID,
      orderId: ORDER_ID,
      provider: 'aeropay',
      providerRef: 'pi_stub_3F9A2K',
      status: 'initiated',
      amountCents: 11019,
      clientSecret: null,
    });
    expect(parsed.provider).toBe('aeropay');
    expect(parsed.clientSecret).toBeNull();
  });

  it('rejects a non-aeropay provider (literal-typed for Phase 5)', () => {
    expect(() =>
      PaymentIntentResponseSchema.parse({
        id: PAYMENT_INTENT_ID,
        orderId: ORDER_ID,
        provider: 'stripe',
        providerRef: 'pi_abc',
        status: 'initiated',
        amountCents: 100,
        clientSecret: null,
      }),
    ).toThrow();
  });
});

describe('CheckoutResponseSchema', () => {
  it('round-trips a representative successful checkout response', () => {
    const parsed = CheckoutResponseSchema.parse({
      order: {
        id: ORDER_ID,
        shortCode: '3F9A2K',
        userId: USER_ID,
        dispensaryId: DISPENSARY_ID,
        deliveryAddressId: ADDRESS_ID,
        status: 'placed',
        subtotalCents: 9000,
        cannabisTaxCents: 900,
        salesTaxCents: 619,
        deliveryFeeCents: 0,
        driverTipCents: 500,
        discountCents: 0,
        totalCents: 11019,
        items: [
          {
            id: ITEM_ID,
            listingId: LISTING_ID,
            productSnapshot: { name: 'Sour Tangie 3.5g' },
            quantity: 2,
            unitPriceCents: 4500,
            lineSubtotalCents: 9000,
            thcMgTotal: '49',
            cbdMgTotal: '0.2',
            weightGramsTotal: '7',
            cannabisTaxCents: 900,
            salesTaxCents: 619,
            createdAt: '2026-05-18T19:00:00.000Z',
          },
        ],
        placedAt: '2026-05-18T19:00:00.000Z',
        statusChangedAt: '2026-05-18T19:00:00.000Z',
        createdAt: '2026-05-18T19:00:00.000Z',
        updatedAt: '2026-05-18T19:00:00.000Z',
      },
      paymentIntent: {
        id: PAYMENT_INTENT_ID,
        orderId: ORDER_ID,
        provider: 'aeropay',
        providerRef: 'pi_stub_3F9A2K',
        status: 'initiated',
        amountCents: 11019,
        clientSecret: null,
      },
      complianceCheck: {
        passed: true,
        rules: [{ rule: 'age', passed: true, details: {} }],
        cartTotals: { flowerGrams: 7, concentrateGrams: 0, edibleThcMg: 0 },
        limits: { flowerGramsMax: 56.7, concentrateGramsMax: 8, edibleThcMgMax: 800 },
        evaluatedAt: '2026-05-18T19:00:00.000Z',
        evaluationVersion: '1.0.0',
      },
    });

    expect(parsed.order.shortCode).toBe('3F9A2K');
    expect(parsed.paymentIntent.provider).toBe('aeropay');
    expect(parsed.complianceCheck.passed).toBe(true);
  });

  it('rejects a shortCode of the wrong length', () => {
    expect(() =>
      CheckoutResponseSchema.parse({
        order: {
          id: ORDER_ID,
          shortCode: 'TOO_LONG',
          userId: USER_ID,
          dispensaryId: DISPENSARY_ID,
          deliveryAddressId: ADDRESS_ID,
          status: 'placed',
          subtotalCents: 0,
          cannabisTaxCents: 0,
          salesTaxCents: 0,
          deliveryFeeCents: 0,
          driverTipCents: 0,
          discountCents: 0,
          totalCents: 0,
          items: [],
          placedAt: '2026-05-18T19:00:00.000Z',
          statusChangedAt: '2026-05-18T19:00:00.000Z',
          createdAt: '2026-05-18T19:00:00.000Z',
          updatedAt: '2026-05-18T19:00:00.000Z',
        },
        paymentIntent: {
          id: PAYMENT_INTENT_ID,
          orderId: ORDER_ID,
          provider: 'aeropay',
          providerRef: 'pi_stub',
          status: 'initiated',
          amountCents: 0,
          clientSecret: null,
        },
        complianceCheck: {
          passed: true,
          rules: [],
          cartTotals: { flowerGrams: 0, concentrateGrams: 0, edibleThcMg: 0 },
          limits: { flowerGramsMax: 56.7, concentrateGramsMax: 8, edibleThcMgMax: 800 },
          evaluatedAt: '2026-05-18T19:00:00.000Z',
          evaluationVersion: '1.0.0',
        },
      }),
    ).toThrow();
  });
});
