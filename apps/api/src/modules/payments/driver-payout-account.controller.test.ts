/**
 * DriverPayoutAccountController unit tests. The controller is a thin
 * pass-through to DriverBankLinkService; what we pin here is that the
 * @CurrentUser() principal's userId and the request body thread to the
 * service unmodified and the responses come back untouched.
 */
import { describe, expect, it } from 'vitest';
import { DriverPayoutAccountController } from './driver-payout-account.controller.js';
import type { DriverBankLinkService } from './driver-bank-link.service.js';
import type { DriverBankAccountStatusResponse, StartDriverBankLinkResponse } from './dto/index.js';
import type { AuthenticatedUser } from '../auth/guards/auth-types.js';

const DRIVER_USER_ID = '01935f3d-0000-7000-8000-000000000801';
const PRINCIPAL: AuthenticatedUser = {
  userId: DRIVER_USER_ID,
  sessionId: '01935f3d-0000-7000-8000-000000000802',
  role: 'driver',
};

const START_RESPONSE: StartDriverBankLinkResponse = {
  link: {
    id: 'link_session_driver_1',
    hostedUrl: 'https://link.aeropay.com/session/driver_1',
    expiresAt: '2026-05-01T03:00:00.000Z',
  },
};

class FakeDriverBankLinkService {
  startCalls: Array<{ driverUserId: string; returnUrl: string }> = [];
  statusCalls: string[] = [];
  nextStatus: DriverBankAccountStatusResponse = { linked: false };

  startLink = (driverUserId: string, returnUrl: string): Promise<StartDriverBankLinkResponse> => {
    this.startCalls.push({ driverUserId, returnUrl });
    return Promise.resolve(START_RESPONSE);
  };

  getStatus = (driverUserId: string): Promise<DriverBankAccountStatusResponse> => {
    this.statusCalls.push(driverUserId);
    return Promise.resolve(this.nextStatus);
  };
}

describe('DriverPayoutAccountController', () => {
  it('startLink forwards the principal userId + returnUrl and returns the session', async () => {
    const svc = new FakeDriverBankLinkService();
    const controller = new DriverPayoutAccountController(svc as unknown as DriverBankLinkService);

    const res = await controller.startLink(PRINCIPAL, {
      returnUrl: 'https://dasher.dankdash.com/payouts/bank/return',
    });

    expect(res).toBe(START_RESPONSE);
    expect(svc.startCalls).toEqual([
      {
        driverUserId: DRIVER_USER_ID,
        returnUrl: 'https://dasher.dankdash.com/payouts/bank/return',
      },
    ]);
  });

  it('getStatus forwards the principal userId and returns the status', async () => {
    const svc = new FakeDriverBankLinkService();
    svc.nextStatus = { linked: true };
    const controller = new DriverPayoutAccountController(svc as unknown as DriverBankLinkService);

    const res = await controller.getStatus(PRINCIPAL);

    expect(res).toEqual({ linked: true });
    expect(svc.statusCalls).toEqual([DRIVER_USER_ID]);
  });
});
