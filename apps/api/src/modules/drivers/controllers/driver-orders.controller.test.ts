/**
 * Unit tests for DriverOrdersController.
 *
 * Guard composition (JwtAuthGuard global, RolesGuard) is verified at the
 * module level. This suite proves the controller forwards the JWT
 * principal's `userId`, the parsed path param, and the request body
 * verbatim to the service, and returns the service's resolved value
 * unmodified — no accidental projection or shape rewrite in the
 * controller layer.
 *
 *   - GET /:id                  → forwards (driverUserId, id) and returns the detail
 *   - GET /:id                  → admin role NEVER substituted for the principal's
 *                                  own userId (belt and suspenders — the role guard
 *                                  already excludes admin, but the controller pins
 *                                  the userId either way)
 *   - POST /:id/pickup-confirm  → forwards (driverUserId, id, body) and returns detail
 *   - POST /:id/delivery-confirm → forwards (driverUserId, id, body) and returns detail
 *
 * The compliance gate (delivery requires `delivery_id_scan_passed`) and
 * the FROM-state gate are enforced by `OrdersRepository.transitionStatus`
 * and exercised by the service- and repo-level tests; the controller
 * test here only proves the wiring.
 */
import { describe, expect, it } from 'vitest';
import { DriverOrdersController } from './driver-orders.controller.js';
import type { AuthenticatedUser } from '../../auth/guards/auth-types.js';
import type {
  DriverDeliveryConfirmRequest,
  DriverOrderDetailResponse,
  DriverPickupConfirmRequest,
} from '../dto/index.js';
import type { DriverOrdersService } from '../services/driver-orders.service.js';

const DRIVER_USER_ID = '01935f3d-0000-7000-8000-000000000101';
const ORDER_ID = '01935f3d-0000-7000-8000-000000000110';
const DISPENSARY_ID = '01935f3d-0000-7000-8000-000000000120';
const ADDRESS_ID = '01935f3d-0000-7000-8000-000000000130';
const CUSTOMER_ID = '01935f3d-0000-7000-8000-000000000140';

const PRINCIPAL: AuthenticatedUser = {
  userId: DRIVER_USER_ID,
  sessionId: '01935f3d-0000-7000-8000-000000000102',
  role: 'driver',
};

const DETAIL: DriverOrderDetailResponse = {
  order: {
    id: ORDER_ID,
    shortCode: 'ABC123',
    userId: CUSTOMER_ID,
    dispensaryId: DISPENSARY_ID,
    deliveryAddressId: ADDRESS_ID,
    status: 'en_route_dropoff',
    subtotalCents: 5000,
    cannabisTaxCents: 500,
    salesTaxCents: 300,
    deliveryFeeCents: 500,
    driverTipCents: 200,
    discountCents: 0,
    totalCents: 6500,
    items: [],
    placedAt: '2026-05-15T18:00:00.000Z',
    statusChangedAt: '2026-05-15T20:30:00.000Z',
    createdAt: '2026-05-15T18:00:00.000Z',
    updatedAt: '2026-05-15T20:30:00.000Z',
  },
  events: [],
  customer: { firstName: 'Sam', lastName: 'J.', maskedPhone: '••• ••• 4321' },
  dispensary: {
    id: DISPENSARY_ID,
    name: 'Twin Cities Cannabis Co',
    addressLine1: '12 Main St',
    addressLine2: null,
    city: 'Minneapolis',
    state: 'MN',
    postalCode: '55401',
    latitude: 44.978,
    longitude: -93.265,
    phone: '+16125550100',
  },
  dropoff: {
    line1: '345 Park Ave',
    line2: 'Apt 4B',
    city: 'St Paul',
    state: 'MN',
    postalCode: '55102',
    latitude: 44.953,
    longitude: -93.094,
    instructions: 'Leave with doorman',
  },
  idScan: { passed: false, verificationId: null, scannedAt: null },
};

const PICKUP_BODY: DriverPickupConfirmRequest = {
  location: {
    latitude: 44.978,
    longitude: -93.265,
    accuracyMeters: 7.5,
    capturedAt: '2026-05-15T20:31:00.000Z',
  },
};

const DELIVERY_BODY: DriverDeliveryConfirmRequest = {
  location: {
    latitude: 44.953,
    longitude: -93.094,
    accuracyMeters: 11.0,
    capturedAt: '2026-05-15T21:02:00.000Z',
  },
  notes: 'Handed to recipient at door',
};

class FakeDriverOrdersService {
  public getCalls: { driverUserId: string; orderId: string }[] = [];
  public pickupCalls: {
    driverUserId: string;
    orderId: string;
    body: DriverPickupConfirmRequest;
  }[] = [];
  public deliveryCalls: {
    driverUserId: string;
    orderId: string;
    body: DriverDeliveryConfirmRequest;
  }[] = [];

  getForDriver = (driverUserId: string, orderId: string): Promise<DriverOrderDetailResponse> => {
    this.getCalls.push({ driverUserId, orderId });
    return Promise.resolve(DETAIL);
  };

  confirmPickup = (
    driverUserId: string,
    orderId: string,
    body: DriverPickupConfirmRequest,
  ): Promise<DriverOrderDetailResponse> => {
    this.pickupCalls.push({ driverUserId, orderId, body });
    return Promise.resolve(DETAIL);
  };

  confirmDelivery = (
    driverUserId: string,
    orderId: string,
    body: DriverDeliveryConfirmRequest,
  ): Promise<DriverOrderDetailResponse> => {
    this.deliveryCalls.push({ driverUserId, orderId, body });
    return Promise.resolve(DETAIL);
  };
}

function makeController(): {
  controller: DriverOrdersController;
  service: FakeDriverOrdersService;
} {
  const service = new FakeDriverOrdersService();
  const controller = new DriverOrdersController(service as unknown as DriverOrdersService);
  return { controller, service };
}

describe('DriverOrdersController', () => {
  it('GET /:id forwards the principal userId and the path param', async () => {
    const { controller, service } = makeController();

    const result = await controller.get(PRINCIPAL, ORDER_ID);

    expect(result).toBe(DETAIL);
    expect(service.getCalls).toEqual([{ driverUserId: DRIVER_USER_ID, orderId: ORDER_ID }]);
  });

  it('GET /:id pins the userId to the principal — does not accept an admin substitute', async () => {
    // RolesGuard excludes non-driver roles, but the controller still
    // pins the userId from the JWT principal even if an admin token
    // somehow reached the handler. Belt and suspenders.
    const { controller, service } = makeController();
    const admin: AuthenticatedUser = {
      userId: '01935f3d-0000-7000-8000-0000000000aa',
      sessionId: 'sess-admin',
      role: 'admin',
    };

    await controller.get(admin, ORDER_ID);

    expect(service.getCalls[0]?.driverUserId).toBe(admin.userId);
  });

  it('POST /:id/pickup-confirm forwards the principal userId, path param, and body', async () => {
    const { controller, service } = makeController();

    const result = await controller.pickupConfirm(PRINCIPAL, ORDER_ID, PICKUP_BODY);

    expect(result).toBe(DETAIL);
    expect(service.pickupCalls).toEqual([
      { driverUserId: DRIVER_USER_ID, orderId: ORDER_ID, body: PICKUP_BODY },
    ]);
  });

  it('POST /:id/pickup-confirm accepts a null-location body (location-denied device)', async () => {
    // BackgroundLocationClient may be denied permission after the route
    // concludes — the handoff must still be recordable. The controller
    // forwards the body verbatim so the service / event payload sees
    // location: null and the audit trail captures the denial.
    const { controller, service } = makeController();
    const body: DriverPickupConfirmRequest = { location: null };

    await controller.pickupConfirm(PRINCIPAL, ORDER_ID, body);

    expect(service.pickupCalls[0]?.body).toEqual({ location: null });
  });

  it('POST /:id/delivery-confirm forwards the principal userId, path param, and body', async () => {
    const { controller, service } = makeController();

    const result = await controller.deliveryConfirm(PRINCIPAL, ORDER_ID, DELIVERY_BODY);

    expect(result).toBe(DETAIL);
    expect(service.deliveryCalls).toEqual([
      { driverUserId: DRIVER_USER_ID, orderId: ORDER_ID, body: DELIVERY_BODY },
    ]);
  });

  it('POST /:id/delivery-confirm pins the userId to the principal even for an admin token', async () => {
    // Same belt-and-suspenders shape as the GET test. RolesGuard rejects
    // non-driver roles, but if an admin token did reach the handler the
    // controller still uses the principal's userId — the gate is on who
    // the JWT says you are, never on a body-supplied identifier.
    const { controller, service } = makeController();
    const admin: AuthenticatedUser = {
      userId: '01935f3d-0000-7000-8000-0000000000aa',
      sessionId: 'sess-admin',
      role: 'admin',
    };

    await controller.deliveryConfirm(admin, ORDER_ID, DELIVERY_BODY);

    expect(service.deliveryCalls[0]?.driverUserId).toBe(admin.userId);
  });
});
