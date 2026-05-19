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
import type {
  CurrentRouteResponse,
  EarningsQuery,
  EarningsResponse,
  ShiftsListResponse,
} from './dto/index.js';
import type { DriverContext } from '../context/driver-context.types.js';

const CTX: DriverContext = {
  driverId: '01935f3d-0000-7000-8000-0000000000d1',
  userId: '01935f3d-0000-7000-8000-0000000000a1',
  currentStatus: 'online',
  currentOrderId: null,
};

const NO_ROUTE: CurrentRouteResponse = { activeOrder: null };

const TODAY_EARNINGS: EarningsResponse = {
  period: 'today',
  since: '2026-05-19T05:00:00.000Z',
  until: '2026-05-20T05:00:00.000Z',
  tipsCents: 1500,
  deliveryFeesCents: 4000,
  deliveriesCount: 5,
  totalCents: 5500,
};

const EMPTY_SHIFTS: ShiftsListResponse = { shifts: [] };

class FakeAppService {
  public currentRouteCalls: { ctx: DriverContext }[] = [];
  public earningsCalls: { ctx: DriverContext; query: EarningsQuery }[] = [];
  public shiftsCalls: { ctx: DriverContext }[] = [];

  currentRoute = (ctx: DriverContext): Promise<CurrentRouteResponse> => {
    this.currentRouteCalls.push({ ctx });
    return Promise.resolve(NO_ROUTE);
  };

  earnings = (ctx: DriverContext, query: EarningsQuery): Promise<EarningsResponse> => {
    this.earningsCalls.push({ ctx, query });
    return Promise.resolve(TODAY_EARNINGS);
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

describe('DriverAppController.earnings', () => {
  it('forwards the context + query to the service', async () => {
    const svc = new FakeAppService();
    const controller = new DriverAppController(svc as unknown as DriverAppService);
    const query: EarningsQuery = { period: 'week' };

    const res = await controller.earnings(CTX, query);

    expect(svc.earningsCalls).toEqual([{ ctx: CTX, query }]);
    expect(res).toEqual(TODAY_EARNINGS);
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
