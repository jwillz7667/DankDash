/**
 * Unit tests for DriverDeliveriesController.
 *
 * The controller is a thin pass-through to DriverDeliveriesService — it
 * owns the DriverContext plumbing, the `:orderId` param, and the rate-
 * limit metadata. Guard wiring (DriverContextGuard, the global
 * JwtAuthGuard) is verified at the module-composition level; these tests
 * bypass the guard and inject a synthetic context, same pattern as the
 * offers / shift controller tests.
 */
import { describe, expect, it } from 'vitest';
import { DriverDeliveriesController } from './driver-deliveries.controller.js';
import type { DriverDeliveriesService } from './driver-deliveries.service.js';
import type { DriverContext } from '../context/driver-context.types.js';
import type {
  AvailableDeliveriesResponse,
  AvailableDelivery,
  ClaimDeliveryResponse,
} from './dto/index.js';

const CTX: DriverContext = {
  driverId: '01935f3d-0000-7000-8000-0000000000d1',
  userId: '01935f3d-0000-7000-8000-0000000000a1',
  currentStatus: 'online',
  currentOrderId: null,
};

const ORDER_ID = '01935f3d-0000-7000-8000-000000000001';

const DELIVERY: AvailableDelivery = {
  orderId: ORDER_ID,
  shortCode: 'AB12',
  dispensaryId: '01935f3d-0000-7000-8000-0000000000c1',
  pickupName: 'Hometown Dispensary',
  pickup: { lat: 44.9778, lng: -93.265 },
  dropoff: { lat: 44.94, lng: -93.1 },
  tipCents: 500,
  totalCents: 8200,
  distanceMeters: 1234.5,
  awaitingDriverAt: '2026-05-19T14:30:00.000Z',
};

const AVAILABLE: AvailableDeliveriesResponse = { deliveries: [DELIVERY] };
const CLAIMED: ClaimDeliveryResponse = { orderId: ORDER_ID, status: 'driver_assigned' };

class FakeDeliveriesService {
  public listCalls: { ctx: DriverContext }[] = [];
  public claimCalls: { ctx: DriverContext; orderId: string }[] = [];

  listAvailable = (ctx: DriverContext): Promise<AvailableDeliveriesResponse> => {
    this.listCalls.push({ ctx });
    return Promise.resolve(AVAILABLE);
  };

  claim = (ctx: DriverContext, orderId: string): Promise<ClaimDeliveryResponse> => {
    this.claimCalls.push({ ctx, orderId });
    return Promise.resolve(CLAIMED);
  };
}

describe('DriverDeliveriesController.listAvailable', () => {
  it('forwards the context to the service and returns the deliveries envelope', async () => {
    const svc = new FakeDeliveriesService();
    const controller = new DriverDeliveriesController(svc as unknown as DriverDeliveriesService);

    const res = await controller.listAvailable(CTX);

    expect(svc.listCalls).toEqual([{ ctx: CTX }]);
    expect(res).toEqual(AVAILABLE);
  });
});

describe('DriverDeliveriesController.claim', () => {
  it('forwards the context + URL orderId to the service and returns the claim result', async () => {
    const svc = new FakeDeliveriesService();
    const controller = new DriverDeliveriesController(svc as unknown as DriverDeliveriesService);

    const res = await controller.claim(CTX, ORDER_ID);

    expect(svc.claimCalls).toEqual([{ ctx: CTX, orderId: ORDER_ID }]);
    expect(res).toEqual(CLAIMED);
  });
});
