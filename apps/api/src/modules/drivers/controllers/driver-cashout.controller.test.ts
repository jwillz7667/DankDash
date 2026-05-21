/**
 * Unit tests for DriverCashoutController — wiring only.
 *
 * The controller is intentionally a thin pass-through; the balance
 * gate, the persistence semantics, and the upstream Aeropay dispatch
 * all live in `DriverCashoutService` (and are exercised there with
 * exhaustive fakes). This suite proves the controller hands the
 * principal's userId + `body.amountCents` to the service and returns
 * the resolved DTO untouched.
 */
import { describe, expect, it } from 'vitest';
import { DriverCashoutController } from './driver-cashout.controller.js';
import type { AuthenticatedUser } from '../../auth/guards/auth-types.js';
import type { DriverCashoutRequestDto, DriverCashoutResponse } from '../dto/index.js';
import type { DriverCashoutService } from '../services/driver-cashout.service.js';

const DRIVER_USER_ID = '01935f3d-0000-7000-8000-0000000006a1';
const PRINCIPAL: AuthenticatedUser = {
  userId: DRIVER_USER_ID,
  sessionId: '01935f3d-0000-7000-8000-0000000006a2',
  role: 'driver',
};

const RESPONSE: DriverCashoutResponse = {
  id: '01935f3d-0000-7000-8000-000000000701',
  amountCents: 4_000,
  status: 'pending',
  requestedAt: '2026-05-19T20:30:00.000Z',
  aeropayPayoutRef: null,
};

class FakeDriverCashoutService {
  public calls: { driverUserId: string; amountCents: number }[] = [];

  requestCashout = (driverUserId: string, amountCents: number): Promise<DriverCashoutResponse> => {
    this.calls.push({ driverUserId, amountCents });
    return Promise.resolve(RESPONSE);
  };
}

function makeController(): {
  controller: DriverCashoutController;
  service: FakeDriverCashoutService;
} {
  const service = new FakeDriverCashoutService();
  const controller = new DriverCashoutController(service as unknown as DriverCashoutService);
  return { controller, service };
}

describe('DriverCashoutController', () => {
  it('POST /cashout forwards the principal userId and amountCents, returns the service value', async () => {
    const { controller, service } = makeController();
    const body: DriverCashoutRequestDto = { amountCents: 4_000 };

    const result = await controller.request(PRINCIPAL, body);

    expect(result).toBe(RESPONSE);
    expect(service.calls).toEqual([{ driverUserId: DRIVER_USER_ID, amountCents: 4_000 }]);
  });

  it('POST /cashout pins the userId to the JWT principal even if an admin token reaches the handler', async () => {
    const { controller, service } = makeController();
    const admin: AuthenticatedUser = {
      userId: '01935f3d-0000-7000-8000-0000000000aa',
      sessionId: 'sess-admin',
      role: 'admin',
    };

    const body: DriverCashoutRequestDto = { amountCents: 1_000 };
    await controller.request(admin, body);

    expect(service.calls[0]?.driverUserId).toBe(admin.userId);
  });
});
