/**
 * Unit tests for VendorOrdersController.
 *
 * Verifies that each endpoint:
 *   1. Pre-checks ownership through OrdersService.findForDispensary
 *      (so a probing vendor on another dispensary's order sees 404 not 422).
 *   2. Fires the correct OrderEventType against OrderTransitionService.
 *   3. Threads the vendor's userId + dispensaryId as the actor.
 *   4. Returns the canonical TransitionResponse shape.
 *
 * Guard wiring (VendorContextGuard reading X-Dispensary-Id, RolesGuard)
 * is module-composition concern.
 */
import { describe, expect, it } from 'vitest';
import { VendorOrdersController } from './vendor-orders.controller.js';
import type { OrderTransitionService } from './order-transition.service.js';
import type { OrdersService } from './orders.service.js';
import type { VendorContext } from '../listings/vendor/vendor-context.types.js';
import type { Dispensary, Driver, Order, OrderStatus, VendorQueueOrderRow } from '@dankdash/db';
import type { OrderEventType } from '@dankdash/orders';

const USER_ID = '01935f3d-0000-7000-8000-000000000003';
const ORDER_ID = '01935f3d-0000-7000-8000-000000001001';
const DISPENSARY_ID = '01935f3d-0000-7000-8000-000000000010';
const STAFF_MEMBER_ID = '01935f3d-0000-7000-8000-000000000080';
const PINNED_NOW = new Date('2026-05-18T19:00:00.000Z');

const CTX: VendorContext = {
  dispensaryId: DISPENSARY_ID,
  userId: USER_ID,
  staffRole: 'manager',
  staffMemberId: STAFF_MEMBER_ID,
};

function makeOrder(status: Order['status'] = 'placed'): Order {
  return {
    id: ORDER_ID,
    shortCode: '7K2X4Q',
    userId: '01935f3d-0000-7000-8000-000000000001',
    dispensaryId: DISPENSARY_ID,
    driverId: null,
    deliveryAddressId: '01935f3d-0000-7000-8000-000000000060',
    status,
    statusChangedAt: PINNED_NOW,
    subtotalCents: 9000,
    cannabisTaxCents: 900,
    salesTaxCents: 619,
    deliveryFeeCents: 0,
    driverTipCents: 500,
    discountCents: 0,
    totalCents: 11019,
    promoCodeId: null,
    discountFundedBy: null,
    complianceCheckPayload: {},
    deliveryAddressSnapshot: {},
    placedAt: PINNED_NOW,
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
  };
}

class FakeOrdersService {
  public findForDispensaryCalls: { dispensaryId: string; orderId: string }[] = [];
  public getVendorOrderDetailCalls: { dispensaryId: string; orderId: string }[] = [];
  public listQueueCalls: {
    dispensaryId: string;
    statuses: readonly OrderStatus[];
    limit: number;
  }[] = [];
  public order: Order = makeOrder();
  public dispensary: Dispensary = {
    location: { type: 'Point', coordinates: [-93.265, 44.9778] },
  } as unknown as Dispensary;
  public driver: Driver | null = null;
  public queueRows: readonly VendorQueueOrderRow[] = [];

  findForDispensary = (dispensaryId: string, orderId: string): Promise<Order> => {
    this.findForDispensaryCalls.push({ dispensaryId, orderId });
    return Promise.resolve(this.order);
  };

  getVendorOrderDetail = (
    dispensaryId: string,
    orderId: string,
  ): Promise<{ order: Order; dispensary: Dispensary; driver: Driver | null }> => {
    this.getVendorOrderDetailCalls.push({ dispensaryId, orderId });
    return Promise.resolve({ order: this.order, dispensary: this.dispensary, driver: this.driver });
  };

  listForDispensaryQueue = (
    dispensaryId: string,
    statuses: readonly OrderStatus[],
    limit: number,
  ): Promise<readonly VendorQueueOrderRow[]> => {
    this.listQueueCalls.push({ dispensaryId, statuses, limit });
    return Promise.resolve(this.queueRows);
  };
}

class FakeTransitionService {
  public calls: {
    orderId: string;
    event: OrderEventType;
    actorRole: string;
    actorUserId?: string;
    actorDispensaryId?: string;
    reason?: string;
  }[] = [];
  public nextToStatus: Order['status'] = 'accepted';

  transition = (req: {
    orderId: string;
    event: OrderEventType;
    actor: { userId?: string; role: string; dispensaryId?: string };
    reason?: string;
  }): Promise<{ orderId: string; fromStatus: Order['status']; toStatus: Order['status'] }> => {
    this.calls.push({
      orderId: req.orderId,
      event: req.event,
      actorRole: req.actor.role,
      ...(req.actor.userId !== undefined ? { actorUserId: req.actor.userId } : {}),
      ...(req.actor.dispensaryId !== undefined
        ? { actorDispensaryId: req.actor.dispensaryId }
        : {}),
      ...(req.reason !== undefined ? { reason: req.reason } : {}),
    });
    return Promise.resolve({
      orderId: req.orderId,
      fromStatus: 'placed',
      toStatus: this.nextToStatus,
    });
  };
}

function makeController(): {
  controller: VendorOrdersController;
  svc: FakeOrdersService;
  tx: FakeTransitionService;
} {
  const svc = new FakeOrdersService();
  const tx = new FakeTransitionService();
  return {
    controller: new VendorOrdersController(
      tx as unknown as OrderTransitionService,
      svc as unknown as OrdersService,
    ),
    svc,
    tx,
  };
}

describe('VendorOrdersController', () => {
  describe('list (queue feed)', () => {
    it('threads statuses + limit through to OrdersService and projects each row', async () => {
      const { controller, svc } = makeController();
      svc.queueRows = [
        {
          ...makeOrder('placed'),
          customerFirstName: 'Ada',
          customerLastName: 'Lovelace',
          itemCount: 3,
        },
      ];

      const res = await controller.list(CTX, {
        statuses: ['placed', 'accepted'],
        limit: 50,
      });

      expect(svc.listQueueCalls).toEqual([
        { dispensaryId: DISPENSARY_ID, statuses: ['placed', 'accepted'], limit: 50 },
      ]);
      expect(res.orders).toHaveLength(1);
      expect(res.orders[0]).toMatchObject({
        id: ORDER_ID,
        customerName: 'Ada Lovelace',
        itemCount: 3,
        status: 'placed',
      });
    });

    it('emits customerName = null when both first/last are missing', async () => {
      const { controller, svc } = makeController();
      svc.queueRows = [
        {
          ...makeOrder('placed'),
          customerFirstName: null,
          customerLastName: null,
          itemCount: 1,
        },
      ];

      const res = await controller.list(CTX, { statuses: ['placed'], limit: 200 });

      expect(res.orders[0]!.customerName).toBeNull();
    });
  });

  describe('get (drawer detail)', () => {
    it('returns the full OrderResponse plus the delivery geometry for the live map', async () => {
      const { controller, svc } = makeController();

      const res = await controller.get(CTX, ORDER_ID);

      expect(svc.getVendorOrderDetailCalls).toEqual([
        { dispensaryId: DISPENSARY_ID, orderId: ORDER_ID },
      ]);
      expect(res.id).toBe(ORDER_ID);
      expect(res.status).toBe('placed');
      expect(res.timestamps.placedAt).toBe(PINNED_NOW.toISOString());
      // PR3: the detail endpoint carries pickup/dropoff (+ driver once
      // assigned) so the portal map paints before the first live tick.
      expect(res.delivery?.pickup).toEqual({ latitude: 44.9778, longitude: -93.265 });
      expect(res.delivery?.driver).toBeNull();
    });
  });

  it('accept → VENDOR_ACCEPT, with ownership pre-check', async () => {
    const { controller, svc, tx } = makeController();
    tx.nextToStatus = 'accepted';

    const res = await controller.accept(CTX, ORDER_ID);

    expect(svc.findForDispensaryCalls).toEqual([
      { dispensaryId: DISPENSARY_ID, orderId: ORDER_ID },
    ]);
    expect(tx.calls).toEqual([
      {
        orderId: ORDER_ID,
        event: 'VENDOR_ACCEPT',
        actorRole: 'vendor',
        actorUserId: USER_ID,
        actorDispensaryId: DISPENSARY_ID,
      },
    ]);
    expect(res.id).toBe(ORDER_ID);
    expect(res.status).toBe('accepted');
    expect(typeof res.statusChangedAt).toBe('string');
  });

  it('reject → VENDOR_REJECT with reason', async () => {
    const { controller, tx } = makeController();
    tx.nextToStatus = 'rejected';

    await controller.reject(CTX, ORDER_ID, { reason: 'out of stock' });

    expect(tx.calls[0]).toEqual({
      orderId: ORDER_ID,
      event: 'VENDOR_REJECT',
      actorRole: 'vendor',
      actorUserId: USER_ID,
      actorDispensaryId: DISPENSARY_ID,
      reason: 'out of stock',
    });
  });

  it('prepped → VENDOR_PREPPING', async () => {
    const { controller, tx } = makeController();
    tx.nextToStatus = 'prepping';

    await controller.prepped(CTX, ORDER_ID);

    expect(tx.calls[0]!.event).toBe('VENDOR_PREPPING');
  });

  it('ready → VENDOR_READY', async () => {
    const { controller, tx } = makeController();
    tx.nextToStatus = 'ready_for_pickup';

    await controller.ready(CTX, ORDER_ID);

    expect(tx.calls[0]!.event).toBe('VENDOR_READY');
  });

  it('handoff → DRIVER_PICKED_UP (vendor confirms driver took possession)', async () => {
    const { controller, tx } = makeController();
    tx.nextToStatus = 'picked_up';

    await controller.handoff(CTX, ORDER_ID);

    expect(tx.calls[0]!.event).toBe('DRIVER_PICKED_UP');
  });
});
