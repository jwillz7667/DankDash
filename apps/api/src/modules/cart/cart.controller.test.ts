/**
 * Unit tests for CartController.
 *
 * Auth wiring (JwtAuthGuard global, RolesGuard) is verified at the
 * module-composition level; this suite proves the controller threads
 * `@CurrentUser() user.userId` and the `@Param('id')` / `@Param('itemId')`
 * values verbatim to the service, and that response shapes round-trip.
 *
 *   - POST  /         → forwards (userId, body)
 *   - GET   /:id      → forwards (userId, id)
 *   - POST  /:id/items                → forwards (userId, id, body)
 *   - PATCH /:id/items/:itemId        → forwards (userId, id, itemId, body)
 *   - DELETE /:id/items/:itemId       → forwards (userId, id, itemId)
 *   - DELETE /:id                     → forwards (userId, id), resolves void
 */
import { describe, expect, it } from 'vitest';
import { CartController } from './cart.controller.js';
import type { CartService } from './cart.service.js';
import type {
  AddCartItemRequest,
  CartResponse,
  CreateCartRequest,
  PatchCartItemRequest,
  ValidateCartResponse,
} from './dto/index.js';
import type { AuthenticatedUser } from '../auth/guards/auth-types.js';

const USER_ID = '01935f3d-0000-7000-8000-000000000001';
const DISPENSARY_ID = '01935f3d-0000-7000-8000-000000000010';
const CART_ID = '01935f3d-0000-7000-8000-000000000020';
const LISTING_ID = '01935f3d-0000-7000-8000-000000000030';
const ITEM_ID = '01935f3d-0000-7000-8000-000000000040';
const ADDRESS_ID = '01935f3d-0000-7000-8000-000000000060';

const PRINCIPAL: AuthenticatedUser = {
  userId: USER_ID,
  sessionId: '01935f3d-0000-7000-8000-000000000002',
  role: 'customer',
};

const CART: CartResponse = {
  id: CART_ID,
  userId: USER_ID,
  dispensaryId: DISPENSARY_ID,
  items: [],
  subtotalCents: 0,
  promoCode: null,
  discountCents: 0,
  expiresAt: '2026-05-18T23:00:00.000Z',
  createdAt: '2026-05-18T18:00:00.000Z',
  updatedAt: '2026-05-18T19:00:00.000Z',
};

const VALIDATION: ValidateCartResponse = {
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
  cartTotals: { flowerGrams: 0, concentrateGrams: 0, edibleThcMg: 0 },
  limits: { flowerGramsMax: 56.7, concentrateGramsMax: 8, edibleThcMgMax: 800 },
  evaluatedAt: '2026-05-18T19:00:00.000Z',
  evaluationVersion: '1.0.0',
};

class FakeCartService {
  public createCalls: { userId: string; body: CreateCartRequest }[] = [];
  public findCalls: { userId: string; cartId: string }[] = [];
  public addCalls: { userId: string; cartId: string; body: AddCartItemRequest }[] = [];
  public patchCalls: {
    userId: string;
    cartId: string;
    itemId: string;
    body: PatchCartItemRequest;
  }[] = [];
  public removeCalls: { userId: string; cartId: string; itemId: string }[] = [];
  public deleteCalls: { userId: string; cartId: string }[] = [];
  public validateCalls: { userId: string; cartId: string; deliveryAddressId: string }[] = [];

  createOrGet = (userId: string, body: CreateCartRequest): Promise<CartResponse> => {
    this.createCalls.push({ userId, body });
    return Promise.resolve({ ...CART, dispensaryId: body.dispensaryId });
  };
  findForUser = (userId: string, cartId: string): Promise<CartResponse> => {
    this.findCalls.push({ userId, cartId });
    return Promise.resolve({ ...CART, id: cartId });
  };
  addItem = (userId: string, cartId: string, body: AddCartItemRequest): Promise<CartResponse> => {
    this.addCalls.push({ userId, cartId, body });
    return Promise.resolve({
      ...CART,
      id: cartId,
      items: [
        {
          id: ITEM_ID,
          listingId: body.listingId,
          quantity: body.quantity,
          unitPriceCents: 4500,
          lineSubtotalCents: 4500 * body.quantity,
          createdAt: '2026-05-18T19:00:00.000Z',
          updatedAt: '2026-05-18T19:00:00.000Z',
        },
      ],
      subtotalCents: 4500 * body.quantity,
    });
  };
  patchItem = (
    userId: string,
    cartId: string,
    itemId: string,
    body: PatchCartItemRequest,
  ): Promise<CartResponse> => {
    this.patchCalls.push({ userId, cartId, itemId, body });
    return Promise.resolve({ ...CART, id: cartId });
  };
  removeItem = (userId: string, cartId: string, itemId: string): Promise<CartResponse> => {
    this.removeCalls.push({ userId, cartId, itemId });
    return Promise.resolve({ ...CART, id: cartId });
  };
  delete = (userId: string, cartId: string): Promise<void> => {
    this.deleteCalls.push({ userId, cartId });
    return Promise.resolve();
  };
  validate = (
    userId: string,
    cartId: string,
    deliveryAddressId: string,
  ): Promise<ValidateCartResponse> => {
    this.validateCalls.push({ userId, cartId, deliveryAddressId });
    return Promise.resolve(VALIDATION);
  };
}

describe('CartController', () => {
  function makeController(): { controller: CartController; svc: FakeCartService } {
    const svc = new FakeCartService();
    return {
      controller: new CartController(svc as unknown as CartService),
      svc,
    };
  }

  it('POST / forwards userId and body to createOrGet', async () => {
    const { controller, svc } = makeController();

    const res = await controller.create(PRINCIPAL, { dispensaryId: DISPENSARY_ID });

    expect(svc.createCalls).toEqual([{ userId: USER_ID, body: { dispensaryId: DISPENSARY_ID } }]);
    expect(res.dispensaryId).toBe(DISPENSARY_ID);
  });

  it('GET /:id forwards userId and id', async () => {
    const { controller, svc } = makeController();

    const res = await controller.get(PRINCIPAL, CART_ID);

    expect(svc.findCalls).toEqual([{ userId: USER_ID, cartId: CART_ID }]);
    expect(res.id).toBe(CART_ID);
  });

  it('POST /:id/items forwards (userId, cartId, body) and returns the cart projection', async () => {
    const { controller, svc } = makeController();

    const res = await controller.addItem(PRINCIPAL, CART_ID, {
      listingId: LISTING_ID,
      quantity: 2,
    });

    expect(svc.addCalls).toEqual([
      { userId: USER_ID, cartId: CART_ID, body: { listingId: LISTING_ID, quantity: 2 } },
    ]);
    expect(res.items).toHaveLength(1);
    expect(res.subtotalCents).toBe(9000);
  });

  it('PATCH /:id/items/:itemId forwards (userId, cartId, itemId, body)', async () => {
    const { controller, svc } = makeController();

    await controller.patchItem(PRINCIPAL, CART_ID, ITEM_ID, { quantity: 5 });

    expect(svc.patchCalls).toEqual([
      { userId: USER_ID, cartId: CART_ID, itemId: ITEM_ID, body: { quantity: 5 } },
    ]);
  });

  it('DELETE /:id/items/:itemId forwards (userId, cartId, itemId)', async () => {
    const { controller, svc } = makeController();

    await controller.removeItem(PRINCIPAL, CART_ID, ITEM_ID);

    expect(svc.removeCalls).toEqual([{ userId: USER_ID, cartId: CART_ID, itemId: ITEM_ID }]);
  });

  it('DELETE /:id forwards (userId, cartId) and resolves void (HTTP 204)', async () => {
    const { controller, svc } = makeController();

    await expect(controller.delete(PRINCIPAL, CART_ID)).resolves.toBeUndefined();

    expect(svc.deleteCalls).toEqual([{ userId: USER_ID, cartId: CART_ID }]);
  });

  it('POST /:id/validate forwards (userId, cartId, deliveryAddressId) and returns the evaluation', async () => {
    const { controller, svc } = makeController();

    const res = await controller.validate(PRINCIPAL, CART_ID, {
      deliveryAddressId: ADDRESS_ID,
    });

    expect(svc.validateCalls).toEqual([
      { userId: USER_ID, cartId: CART_ID, deliveryAddressId: ADDRESS_ID },
    ]);
    expect(res.passed).toBe(true);
    expect(res.rules).toHaveLength(7);
  });
});
