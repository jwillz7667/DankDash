/**
 * VendorPayoutsController unit tests.
 *
 * Controller owns route-param plumbing and response shape. Auth wiring
 * (VendorContextGuard + RolesGuard) is verified at the module
 * composition level; here we exercise that the controller threads
 * `@CurrentDispensary() ctx` and `@Param` verbatim to the service.
 */
import { describe, expect, it } from 'vitest';
import { VendorPayoutsController } from './vendor-payouts.controller.js';
import type { VendorPayoutDetailResponse, VendorPayoutListResponse } from './dto/index.js';
import type { VendorContext } from '../../listings/vendor/vendor-context.types.js';
import type { VendorPayoutsService } from './vendor-payouts.service.js';

const CTX: VendorContext = {
  dispensaryId: '01935f3d-0000-7000-8000-0000000000d1',
  userId: '01935f3d-0000-7000-8000-0000000000a1',
  staffRole: 'manager',
  staffMemberId: '01935f3d-0000-7000-8000-0000000000a2',
};

const PAYOUT_ID = '01935f3d-0000-7000-8000-0000000000b1';

const LIST_RESPONSE: VendorPayoutListResponse = {
  payouts: [
    {
      id: PAYOUT_ID,
      periodStart: '2026-05-17',
      periodEnd: '2026-05-18',
      grossCents: 125_000,
      feesCents: 1_500,
      netCents: 123_500,
      status: 'completed',
      scheduledFor: '2026-05-18',
      aeropayPayoutRef: 'aero_payout_123',
      initiatedAt: '2026-05-18T08:00:00.000Z',
      completedAt: '2026-05-18T08:15:00.000Z',
      failureReason: null,
      createdAt: '2026-05-18T08:00:00.000Z',
    },
  ],
};

const DETAIL_RESPONSE: VendorPayoutDetailResponse = {
  ...LIST_RESPONSE.payouts[0]!,
  orders: [
    {
      id: '01935f3d-0000-7000-8000-0000000000c1',
      shortCode: 'DD-AAAA-01',
      deliveredAt: '2026-05-17T22:13:00.000Z',
      subtotalCents: 4500,
      discountCents: 0,
      totalCents: 5000,
      customerFirstName: 'Jane',
      customerLastName: 'Doe',
    },
  ],
};

class FakeVendorPayoutsService {
  public listCalls: { ctx: VendorContext }[] = [];
  public findCalls: { ctx: VendorContext; payoutId: string }[] = [];

  list = (ctx: VendorContext): Promise<VendorPayoutListResponse> => {
    this.listCalls.push({ ctx });
    return Promise.resolve(LIST_RESPONSE);
  };

  findById = (ctx: VendorContext, payoutId: string): Promise<VendorPayoutDetailResponse> => {
    this.findCalls.push({ ctx, payoutId });
    return Promise.resolve(DETAIL_RESPONSE);
  };
}

describe('VendorPayoutsController.list', () => {
  it('forwards ctx and returns the list response', async () => {
    const svc = new FakeVendorPayoutsService();
    const controller = new VendorPayoutsController(svc as unknown as VendorPayoutsService);

    const res = await controller.list(CTX);

    expect(svc.listCalls).toEqual([{ ctx: CTX }]);
    expect(res).toEqual(LIST_RESPONSE);
  });
});

describe('VendorPayoutsController.findById', () => {
  it('forwards (ctx, payoutId) and returns the detail response', async () => {
    const svc = new FakeVendorPayoutsService();
    const controller = new VendorPayoutsController(svc as unknown as VendorPayoutsService);

    const res = await controller.findById(CTX, PAYOUT_ID);

    expect(svc.findCalls).toEqual([{ ctx: CTX, payoutId: PAYOUT_ID }]);
    expect(res).toEqual(DETAIL_RESPONSE);
  });
});
