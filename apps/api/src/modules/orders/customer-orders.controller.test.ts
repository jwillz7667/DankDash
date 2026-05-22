/**
 * Unit tests for CustomerOrdersController.
 *
 * Guards (RolesGuard, JwtAuthGuard) are composition concerns; here we only
 * verify the controller threads `(userId, orderId, body)` to the right
 * service method and projects the response shape correctly. Cancel-event
 * dispatch (CUSTOMER_CANCEL + canceledBy patch) gets the closest scrutiny
 * because it's the only consumer-side mutation.
 */
import { describe, expect, it } from 'vitest';
import { CustomerOrdersController } from './customer-orders.controller.js';
import { projectOrder } from './order.projection.js';
import type { CancelOrderRequest, ListOrdersQuery, RateOrderRequest } from './dto/index.js';
import type { OrderTransitionService } from './order-transition.service.js';
import type { OrdersService } from './orders.service.js';
import type { AuthenticatedUser } from '../auth/guards/auth-types.js';
import type { Order } from '@dankdash/db';

const USER_ID = '01935f3d-0000-7000-8000-000000000001';
const ORDER_ID = '01935f3d-0000-7000-8000-000000001001';
const PINNED_NOW = new Date('2026-05-18T19:00:00.000Z');

const PRINCIPAL: AuthenticatedUser = {
  userId: USER_ID,
  sessionId: '01935f3d-0000-7000-8000-000000000002',
  role: 'customer',
};

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    shortCode: '7K2X4Q',
    userId: USER_ID,
    dispensaryId: '01935f3d-0000-7000-8000-000000000010',
    driverId: null,
    deliveryAddressId: '01935f3d-0000-7000-8000-000000000060',
    status: 'placed',
    statusChangedAt: PINNED_NOW,
    subtotalCents: 9000,
    cannabisTaxCents: 900,
    salesTaxCents: 619,
    deliveryFeeCents: 0,
    driverTipCents: 500,
    discountCents: 0,
    totalCents: 11019,
    complianceCheckPayload: {},
    deliveryAddressSnapshot: {},
    placedAt: PINNED_NOW,
    paymentFailedAt: null,
    acceptedAt: null,
    rejectedAt: null,
    preppingAt: null,
    preparedAt: null,
    awaitingDriverAt: null,
    driverAssignedAt: null,
    enRoutePickupAt: null,
    pickedUpAt: null,
    enRouteDropoffAt: null,
    arrivedAtDropoffAt: null,
    idScanPendingAt: null,
    deliveredAt: null,
    returnedToStoreAt: null,
    canceledAt: null,
    canceledBy: null,
    cancelReason: null,
    disputedAt: null,
    deliveryIdScanRef: null,
    deliveryIdScanPassed: null,
    deliveryIdScanAt: null,
    customerRating: null,
    customerReview: null,
    dispensaryRating: null,
    driverRating: null,
    ratedAt: null,
    createdAt: PINNED_NOW,
    updatedAt: PINNED_NOW,
    ...overrides,
  };
}

class FakeOrdersService {
  public calls: { method: string; args: unknown[] }[] = [];
  public ordersForUser: Order[] = [];
  public orderForUser: Order | null = null;
  public ratingResult: Order | null = null;

  listForUser = (userId: string, limit: number): Promise<readonly Order[]> => {
    this.calls.push({ method: 'listForUser', args: [userId, limit] });
    return Promise.resolve(this.ordersForUser);
  };

  findForUser = (userId: string, orderId: string): Promise<Order> => {
    this.calls.push({ method: 'findForUser', args: [userId, orderId] });
    if (this.orderForUser === null)
      throw new TypeError('FakeOrdersService.orderForUser was not set');
    return Promise.resolve(this.orderForUser);
  };

  recordRating = (userId: string, orderId: string, req: RateOrderRequest): Promise<Order> => {
    this.calls.push({ method: 'recordRating', args: [userId, orderId, req] });
    if (this.ratingResult === null)
      throw new TypeError('FakeOrdersService.ratingResult was not set');
    return Promise.resolve(this.ratingResult);
  };
}

class FakeTransitionService {
  public calls: unknown[] = [];
  public result = {
    orderId: ORDER_ID,
    fromStatus: 'placed' as const,
    toStatus: 'canceled' as const,
  };

  transition = (req: unknown): Promise<typeof this.result> => {
    this.calls.push(req);
    return Promise.resolve(this.result);
  };
}

function makeController(): {
  controller: CustomerOrdersController;
  svc: FakeOrdersService;
  tx: FakeTransitionService;
} {
  const svc = new FakeOrdersService();
  const tx = new FakeTransitionService();
  const controller = new CustomerOrdersController(
    svc as unknown as OrdersService,
    tx as unknown as OrderTransitionService,
  );
  return { controller, svc, tx };
}

describe('CustomerOrdersController', () => {
  describe('list', () => {
    it('passes (userId, limit) through and projects each row', async () => {
      const { controller, svc } = makeController();
      svc.ordersForUser = [makeOrder()];
      const query: ListOrdersQuery = { limit: 25 };

      const res = await controller.list(PRINCIPAL, query);

      expect(svc.calls).toEqual([{ method: 'listForUser', args: [USER_ID, 25] }]);
      expect(res.orders).toHaveLength(1);
      expect(res.orders[0]!.id).toBe(ORDER_ID);
    });
  });

  describe('get', () => {
    it('returns the projected single order', async () => {
      const { controller, svc } = makeController();
      svc.orderForUser = makeOrder({ status: 'accepted' });

      const res = await controller.get(PRINCIPAL, ORDER_ID);

      expect(svc.calls).toEqual([{ method: 'findForUser', args: [USER_ID, ORDER_ID] }]);
      expect(res).toEqual(projectOrder(svc.orderForUser));
    });
  });

  describe('cancel', () => {
    it('pre-checks ownership then sends CUSTOMER_CANCEL with the canceledBy + cancelReason patch', async () => {
      const { controller, svc, tx } = makeController();
      svc.orderForUser = makeOrder();
      const body: CancelOrderRequest = { reason: 'changed my mind' };

      const res = await controller.cancel(PRINCIPAL, ORDER_ID, body);

      // Pre-check ownership ran first
      expect(svc.calls[0]).toEqual({ method: 'findForUser', args: [USER_ID, ORDER_ID] });

      // Then transition was called with the right shape
      expect(tx.calls).toHaveLength(1);
      expect(tx.calls[0]).toMatchObject({
        orderId: ORDER_ID,
        event: 'CUSTOMER_CANCEL',
        actor: { userId: USER_ID, role: 'customer' },
        reason: 'changed my mind',
        patch: { canceledBy: USER_ID, cancelReason: 'changed my mind' },
      });

      expect(res.id).toBe(ORDER_ID);
      expect(res.status).toBe('canceled');
      expect(typeof res.statusChangedAt).toBe('string');
    });

    it('omits `reason` and `cancelReason` when the body did not supply one', async () => {
      const { controller, svc, tx } = makeController();
      svc.orderForUser = makeOrder();

      await controller.cancel(PRINCIPAL, ORDER_ID, {});

      const sent = tx.calls[0] as { reason?: string; patch: Record<string, unknown> };
      expect(sent.reason).toBeUndefined();
      expect(sent.patch).toEqual({ canceledBy: USER_ID });
    });
  });

  describe('rate', () => {
    it('threads (userId, orderId, body) to recordRating and projects the result', async () => {
      const { controller, svc } = makeController();
      svc.ratingResult = makeOrder({ status: 'delivered', customerRating: 5 });

      const body: RateOrderRequest = { rating: 5, review: 'great' };
      const res = await controller.rate(PRINCIPAL, ORDER_ID, body);

      expect(svc.calls).toEqual([{ method: 'recordRating', args: [USER_ID, ORDER_ID, body] }]);
      expect(res.id).toBe(ORDER_ID);
      expect(res.ratings.customer).toBe(5);
    });
  });
});
