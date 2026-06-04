/**
 * Unit tests for DriverAppController.
 *
 * The controller is a thin pass-through to DriverAppService — it owns
 * the DriverContext plumbing, query DTO shape, and rate-limit metadata.
 * Guard wiring (DriverContextGuard, the global JwtAuthGuard) is
 * verified at the module-composition level; these tests bypass the
 * guard and inject a synthetic context, same pattern as the shift /
 * offers controller tests.
 */
import { describe, expect, it } from 'vitest';
import { DriverAppController } from './driver-app.controller.js';
import type { DriverAppService } from './driver-app.service.js';
import type { CurrentRouteResponse, ShiftsListResponse } from './dto/index.js';
import type { DriverContext } from '../context/driver-context.types.js';

const CTX: DriverContext = {
  driverId: '01935f3d-0000-7000-8000-0000000000d1',
  userId: '01935f3d-0000-7000-8000-0000000000a1',
  currentStatus: 'online',
  currentOrderId: null,
};

const NO_ROUTE: CurrentRouteResponse = { activeOrder: null };

const EMPTY_SHIFTS: ShiftsListResponse = { shifts: [] };

class FakeAppService {
  public currentRouteCalls: { ctx: DriverContext }[] = [];
  public shiftsCalls: { ctx: DriverContext }[] = [];

  currentRoute = (ctx: DriverContext): Promise<CurrentRouteResponse> => {
    this.currentRouteCalls.push({ ctx });
    return Promise.resolve(NO_ROUTE);
  };

  shifts = (ctx: DriverContext): Promise<ShiftsListResponse> => {
    this.shiftsCalls.push({ ctx });
    return Promise.resolve(EMPTY_SHIFTS);
  };
}

describe('DriverAppController.currentRoute', () => {
  it('forwards the context to the service and returns the route', async () => {
    const svc = new FakeAppService();
    const controller = new DriverAppController(svc as unknown as DriverAppService);

    const res = await controller.currentRoute(CTX);

    expect(svc.currentRouteCalls).toEqual([{ ctx: CTX }]);
    expect(res).toEqual(NO_ROUTE);
  });
});

describe('DriverAppController.shifts', () => {
  it('forwards the context to the service', async () => {
    const svc = new FakeAppService();
    const controller = new DriverAppController(svc as unknown as DriverAppService);

    const res = await controller.shifts(CTX);

    expect(svc.shiftsCalls).toEqual([{ ctx: CTX }]);
    expect(res).toEqual(EMPTY_SHIFTS);
  });
});
