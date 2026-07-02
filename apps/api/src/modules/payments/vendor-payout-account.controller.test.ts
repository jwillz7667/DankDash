/**
 * VendorPayoutAccountController unit tests. The controller is a thin
 * pass-through to DispensaryBankLinkService; what we pin here is that the
 * @CurrentDispensary() VendorContext and the request body thread to the
 * service unmodified and the responses come back untouched.
 */
import { describe, expect, it } from 'vitest';
import { VendorPayoutAccountController } from './vendor-payout-account.controller.js';
import type { DispensaryBankLinkService } from './dispensary-bank-link.service.js';
import type {
  DispensaryBankAccountStatusResponse,
  StartDispensaryBankLinkResponse,
} from './dto/index.js';
import type { VendorContext } from '../listings/vendor/vendor-context.types.js';

const CTX: VendorContext = {
  dispensaryId: '01935f3d-0000-7000-8000-0000000000d0',
  userId: '01935f3d-0000-7000-8000-000000000001',
  staffRole: 'owner',
  staffMemberId: '01935f3d-0000-7000-8000-0000000000a1',
};

const START_RESPONSE: StartDispensaryBankLinkResponse = {
  link: {
    id: 'link_session_disp_1',
    hostedUrl: 'https://link.aeropay.com/session/disp_1',
    expiresAt: '2026-05-01T03:00:00.000Z',
  },
};

class FakeDispensaryBankLinkService {
  startCalls: Array<{ ctx: VendorContext; returnUrl: string }> = [];
  statusCalls: VendorContext[] = [];
  nextStatus: DispensaryBankAccountStatusResponse = { linked: false };

  startLink = (ctx: VendorContext, returnUrl: string): Promise<StartDispensaryBankLinkResponse> => {
    this.startCalls.push({ ctx, returnUrl });
    return Promise.resolve(START_RESPONSE);
  };

  getStatus = (ctx: VendorContext): Promise<DispensaryBankAccountStatusResponse> => {
    this.statusCalls.push(ctx);
    return Promise.resolve(this.nextStatus);
  };
}

describe('VendorPayoutAccountController', () => {
  it('startLink forwards the vendor context + returnUrl and returns the session', async () => {
    const svc = new FakeDispensaryBankLinkService();
    const controller = new VendorPayoutAccountController(
      svc as unknown as DispensaryBankLinkService,
    );

    const res = await controller.startLink(CTX, {
      returnUrl: 'https://portal.dankdash.com/payouts/bank/return',
    });

    expect(res).toBe(START_RESPONSE);
    expect(svc.startCalls).toEqual([
      { ctx: CTX, returnUrl: 'https://portal.dankdash.com/payouts/bank/return' },
    ]);
  });

  it('getStatus forwards the vendor context and returns the status', async () => {
    const svc = new FakeDispensaryBankLinkService();
    svc.nextStatus = { linked: true };
    const controller = new VendorPayoutAccountController(
      svc as unknown as DispensaryBankLinkService,
    );

    const res = await controller.getStatus(CTX);

    expect(res).toEqual({ linked: true });
    expect(svc.statusCalls).toEqual([CTX]);
  });
});
