/**
 * Unit tests for DriverShiftController.
 *
 * The controller is a thin pass-through to DriverShiftService; what it
 * owns is the DriverContext plumbing and the response shape. Guard
 * wiring (DriverContextGuard, the global JwtAuthGuard) is verified at
 * the module-composition level — these tests bypass the guard and
 * inject a synthetic context, the same way the rest of the codebase
 * tests its driver-self / vendor-self controllers.
 */
import { describe, expect, it } from 'vitest';
import { DriverShiftController } from './driver-shift.controller.js';
import type { DriverShiftService } from './driver-shift.service.js';
import type { DriverContext } from '../context/driver-context.types.js';
import type { DriverResponse } from '../dto/index.js';
import type {
  DriverShiftResponse,
  EndShiftRequest,
  SelfSettableDriverStatus,
  StartShiftRequest,
} from './dto/index.js';

const CTX: DriverContext = {
  driverId: '01935f3d-0000-7000-8000-0000000000d1',
  userId: '01935f3d-0000-7000-8000-0000000000a1',
  currentStatus: 'offline',
  currentOrderId: null,
};

const SHIFT: DriverShiftResponse = {
  id: '01935f3d-0000-7000-8000-0000000000f1',
  driverId: CTX.driverId,
  startedAt: '2026-05-18T19:00:00.000Z',
  endedAt: null,
  startingLocation: { type: 'Point', coordinates: [-93.265, 44.977] },
  endingLocation: null,
  totalMiles: null,
  totalDeliveries: 0,
  totalEarningsCents: 0,
};

const DRIVER: DriverResponse = {
  id: CTX.driverId,
  userId: CTX.userId,
  vehicleMake: null,
  vehicleModel: null,
  vehicleYear: null,
  vehiclePlate: null,
  vehicleColor: null,
  insuranceDocKey: null,
  insuranceExpiresAt: null,
  backgroundCheckPassedAt: null,
  backgroundCheckProviderRef: null,
  currentStatus: 'on_break',
  lastStatusChangeAt: '2026-05-18T19:00:00.000Z',
  currentLocation: null,
  currentLocationUpdatedAt: null,
  currentOrderId: null,
  ratingAvg: null,
  ratingCount: 0,
  totalDeliveries: 0,
  createdAt: '2026-05-18T19:00:00.000Z',
  updatedAt: '2026-05-18T19:00:00.000Z',
};

class FakeShiftService {
  public startCalls: { ctx: DriverContext; body: StartShiftRequest }[] = [];
  public endCalls: { ctx: DriverContext; body: EndShiftRequest }[] = [];
  public statusCalls: { ctx: DriverContext; status: SelfSettableDriverStatus }[] = [];

  start = (ctx: DriverContext, body: StartShiftRequest): Promise<DriverShiftResponse> => {
    this.startCalls.push({ ctx, body });
    return Promise.resolve(SHIFT);
  };

  end = (ctx: DriverContext, body: EndShiftRequest): Promise<DriverShiftResponse> => {
    this.endCalls.push({ ctx, body });
    return Promise.resolve({
      ...SHIFT,
      endedAt: '2026-05-18T22:00:00.000Z',
      endingLocation: body.endingLocation,
    });
  };

  updateStatus = (
    ctx: DriverContext,
    status: SelfSettableDriverStatus,
  ): Promise<DriverResponse> => {
    this.statusCalls.push({ ctx, status });
    return Promise.resolve({ ...DRIVER, currentStatus: status });
  };
}

describe('DriverShiftController.start', () => {
  it('forwards the context and body to the service and returns the shift', async () => {
    const svc = new FakeShiftService();
    const controller = new DriverShiftController(svc as unknown as DriverShiftService);
    const body: StartShiftRequest = {
      startingLocation: { type: 'Point', coordinates: [-93.265, 44.977] },
    };

    const res = await controller.start(CTX, body);

    expect(svc.startCalls).toEqual([{ ctx: CTX, body }]);
    expect(res).toEqual(SHIFT);
  });
});

describe('DriverShiftController.end', () => {
  it('forwards the context and body to the service and returns the closed shift', async () => {
    const svc = new FakeShiftService();
    const controller = new DriverShiftController(svc as unknown as DriverShiftService);
    const body: EndShiftRequest = {
      endingLocation: { type: 'Point', coordinates: [-93.27, 44.98] },
    };

    const res = await controller.end(CTX, body);

    expect(svc.endCalls).toEqual([{ ctx: CTX, body }]);
    expect(res.endedAt).toBe('2026-05-18T22:00:00.000Z');
    expect(res.endingLocation).toEqual(body.endingLocation);
  });
});

describe('DriverShiftController.updateStatus', () => {
  it('unwraps body.status and forwards to the service', async () => {
    const svc = new FakeShiftService();
    const controller = new DriverShiftController(svc as unknown as DriverShiftService);

    const res = await controller.updateStatus(CTX, { status: 'on_break' });

    expect(svc.statusCalls).toEqual([{ ctx: CTX, status: 'on_break' }]);
    expect(res.currentStatus).toBe('on_break');
  });
});
