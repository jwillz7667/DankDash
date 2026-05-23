/**
 * Unit tests for DriverEarningsController — wiring only.
 *
 * Guard composition (JwtAuthGuard global + `@Roles('driver')`) is verified
 * at the module / E2E level. This suite proves the controller forwards
 * the JWT principal's `userId` and the parsed `period` query verbatim to
 * the service, and returns the service's resolved value unmodified.
 *
 * Period validation is enforced by `DriverEarningsQuerySchema` through
 * the global ZodValidationPipe — exercised in the DTO tests; the
 * controller itself trusts the typed input.
 */
import { describe, expect, it } from 'vitest';
import { DriverEarningsController } from './driver-earnings.controller.js';
import type { AuthenticatedUser } from '../../auth/guards/auth-types.js';
import type {
  DriverEarningsQueryDto,
  DriverEarningsResponse,
  EarningsPeriod,
} from '../dto/index.js';
import type { DriverEarningsService } from '../services/driver-earnings.service.js';

const DRIVER_USER_ID = '01935f3d-0000-7000-8000-0000000005a1';
const PRINCIPAL: AuthenticatedUser = {
  userId: DRIVER_USER_ID,
  sessionId: '01935f3d-0000-7000-8000-0000000005a2',
  role: 'driver',
};

const RESPONSE: DriverEarningsResponse = {
  period: 'week',
  since: '2026-05-18T05:00:00.000Z',
  until: '2026-05-25T05:00:00.000Z',
  tipsCents: 4_200,
  deliveryFeesCents: 6_500,
  deliveriesCount: 7,
  totalCents: 10_700,
};

class FakeDriverEarningsService {
  public calls: { driverUserId: string; period: EarningsPeriod }[] = [];

  getEarnings = (driverUserId: string, period: EarningsPeriod): Promise<DriverEarningsResponse> => {
    this.calls.push({ driverUserId, period });
    return Promise.resolve(RESPONSE);
  };
}

function makeController(): {
  controller: DriverEarningsController;
  service: FakeDriverEarningsService;
} {
  const service = new FakeDriverEarningsService();
  const controller = new DriverEarningsController(service as unknown as DriverEarningsService);
  return { controller, service };
}

describe('DriverEarningsController', () => {
  it('GET /earnings forwards the principal userId and parsed period, returns the service value', async () => {
    const { controller, service } = makeController();
    const query: DriverEarningsQueryDto = { period: 'week' };

    const result = await controller.getEarnings(PRINCIPAL, query);

    expect(result).toBe(RESPONSE);
    expect(service.calls).toEqual([{ driverUserId: DRIVER_USER_ID, period: 'week' }]);
  });

  it('GET /earnings pins the userId to the JWT principal even for an admin token', async () => {
    // RolesGuard narrows to driver, but the controller still uses the
    // principal's userId — never accepts a body-supplied identifier.
    const { controller, service } = makeController();
    const admin: AuthenticatedUser = {
      userId: '01935f3d-0000-7000-8000-0000000000aa',
      sessionId: 'sess-admin',
      role: 'admin',
    };

    const todayQuery: DriverEarningsQueryDto = { period: 'today' };
    await controller.getEarnings(admin, todayQuery);

    expect(service.calls[0]?.driverUserId).toBe(admin.userId);
    expect(service.calls[0]?.period).toBe('today');
  });

  it('GET /earnings passes each of the three buckets through verbatim', async () => {
    const { controller, service } = makeController();
    const today: DriverEarningsQueryDto = { period: 'today' };
    const week: DriverEarningsQueryDto = { period: 'week' };
    const month: DriverEarningsQueryDto = { period: 'month' };

    await controller.getEarnings(PRINCIPAL, today);
    await controller.getEarnings(PRINCIPAL, week);
    await controller.getEarnings(PRINCIPAL, month);

    expect(service.calls.map((c) => c.period)).toEqual(['today', 'week', 'month']);
  });
});
