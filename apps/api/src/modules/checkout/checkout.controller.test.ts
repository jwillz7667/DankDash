/**
 * Unit tests for CheckoutController.
 *
 * Verifies the controller threads `@CurrentUser() user.userId`, the
 * `@Param('id')` cart id, and the validated body verbatim to the service
 * and returns the service's response unchanged. Guard wiring (JwtAuthGuard
 * global, RolesGuard) is module-composition concern, not tested here.
 */
import { describe, expect, it } from 'vitest';
import { CheckoutController } from './checkout.controller.js';
import type { CheckoutService } from './checkout.service.js';
import type { CheckoutRequest, CheckoutResponse } from './dto/index.js';
import type { AuthenticatedUser } from '../auth/guards/auth-types.js';

const USER_ID = '01935f3d-0000-7000-8000-000000000001';
const CART_ID = '01935f3d-0000-7000-8000-000000000020';
const ADDRESS_ID = '01935f3d-0000-7000-8000-000000000060';
const ORDER_ID = '01935f3d-0000-7000-8000-000000001000';
const ITEM_ID = '01935f3d-0000-7000-8000-000000002000';
const PAYMENT_INTENT_ID = '01935f3d-0000-7000-8000-000000004000';
const LISTING_ID = '01935f3d-0000-7000-8000-000000000030';
const DISPENSARY_ID = '01935f3d-0000-7000-8000-000000000010';

const PRINCIPAL: AuthenticatedUser = {
  userId: USER_ID,
  sessionId: '01935f3d-0000-7000-8000-000000000002',
  role: 'customer',
};

const RESPONSE: CheckoutResponse = {
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
        productSnapshot: { name: 'Sour Tangie' },
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
    rules: [
      { rule: 'age', passed: true, details: {} },
      { rule: 'kyc', passed: true, details: {} },
      { rule: 'dispensary_license', passed: true, details: {} },
      { rule: 'hours', passed: true, details: {} },
      { rule: 'delivery_geofence', passed: true, details: {} },
      { rule: 'per_transaction_limit', passed: true, details: {} },
      { rule: 'product_provenance', passed: true, details: {} },
    ],
    cartTotals: { flowerGrams: 7, concentrateGrams: 0, edibleThcMg: 0 },
    limits: { flowerGramsMax: 56.7, concentrateGramsMax: 8, edibleThcMgMax: 800 },
    evaluatedAt: '2026-05-18T19:00:00.000Z',
    evaluationVersion: '1.0.0',
  },
};

class FakeCheckoutService {
  public calls: { userId: string; cartId: string; body: CheckoutRequest }[] = [];

  checkout = (userId: string, cartId: string, body: CheckoutRequest): Promise<CheckoutResponse> => {
    this.calls.push({ userId, cartId, body });
    return Promise.resolve(RESPONSE);
  };
}

describe('CheckoutController.create', () => {
  function makeController(): { controller: CheckoutController; svc: FakeCheckoutService } {
    const svc = new FakeCheckoutService();
    return {
      controller: new CheckoutController(svc as unknown as CheckoutService),
      svc,
    };
  }

  it('forwards (userId, cartId, body) verbatim and returns the service response', async () => {
    const { controller, svc } = makeController();
    const body: CheckoutRequest = {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 500,
    };

    const res = await controller.create(PRINCIPAL, CART_ID, body);

    expect(svc.calls).toEqual([{ userId: USER_ID, cartId: CART_ID, body }]);
    expect(res).toBe(RESPONSE);
  });

  it('passes an optional deliveryInstructions field through to the service', async () => {
    const { controller, svc } = makeController();
    const body: CheckoutRequest = {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 200,
      deliveryInstructions: 'Leave at door',
    };

    await controller.create(PRINCIPAL, CART_ID, body);

    expect(svc.calls[0]?.body.deliveryInstructions).toBe('Leave at door');
  });

  it('forwards a supplied paymentMethodId verbatim', async () => {
    const { controller, svc } = makeController();
    const paymentMethodId = '01935f3d-0000-7000-8000-000000000070';

    await controller.create(PRINCIPAL, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
      driverTipCents: 200,
      paymentMethodId,
    });

    expect(svc.calls[0]?.body.paymentMethodId).toBe(paymentMethodId);
  });
});
