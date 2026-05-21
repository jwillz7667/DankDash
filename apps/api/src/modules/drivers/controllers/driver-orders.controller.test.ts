/**
 * Unit tests for DriverOrdersController.
 *
 * Guard composition (JwtAuthGuard global, RolesGuard) is verified at the
 * module level. This suite proves the controller forwards the JWT
 * principal's `userId` and the parsed path param verbatim to the
 * service, and returns the service's resolved value unmodified — no
 * accidental projection or shape rewrite in the controller layer.
 *
 *   - GET /:id              → forwards (driverUserId, id) and returns the detail
 *   - GET /:id              → admin role NEVER substituted for the principal's
 *                              own userId (defense in depth — the role guard
 *                              already excludes admin, but the controller pins
 *                              the userId either way)
 */
import { describe, expect, it } from 'vitest';
import { DriverOrdersController } from './driver-orders.controller.js';
import type { AuthenticatedUser } from '../../auth/guards/auth-types.js';
import type { DriverOrderDetailResponse } from '../dto/index.js';
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

class FakeDriverOrdersService {
  public getCalls: { driverUserId: string; orderId: string }[] = [];

  getForDriver = (driverUserId: string, orderId: string): Promise<DriverOrderDetailResponse> => {
    this.getCalls.push({ driverUserId, orderId });
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
});
