/**
 * VendorRefundsController unit tests. The controller is a thin
 * pass-through to RefundsService.initiate; what we pin here is that the
 * @CurrentDispensary() VendorContext, the :id path param, and the request
 * body all thread to the service unmodified, and that the response is
 * wrapped as `{ refund }`.
 */
import { describe, expect, it } from 'vitest';
import { VendorRefundsController } from './vendor-refunds.controller.js';
import type { InitiateRefundRequest, RefundResponse } from './dto/index.js';
import type { RefundsService } from './refunds.service.js';
import type { VendorContext } from '../listings/vendor/vendor-context.types.js';

const CTX: VendorContext = {
  dispensaryId: '01935f3d-0000-7000-8000-0000000000d0',
  userId: '01935f3d-0000-7000-8000-000000000001',
  staffRole: 'manager',
  staffMemberId: '01935f3d-0000-7000-8000-0000000000a1',
};

const ORDER_ID = '01935f3d-0000-7000-8000-0000000000a0';

const REFUND: RefundResponse = {
  id: '01935f3d-0000-7000-8000-0000000000b0',
  orderId: ORDER_ID,
  amountCents: 2_500,
  reasonCode: 'damaged_packaging',
  reasonNotes: null,
  initiatedBy: CTX.userId,
  approvedBy: null,
  providerRef: 'aeropay_refund_test_1',
  status: 'completed',
  createdAt: '2026-05-18T15:00:00.000Z',
  completedAt: '2026-05-18T15:00:01.000Z',
  requiresAdminApproval: false,
};

class FakeRefundsService {
  calls: Array<{ ctx: VendorContext; orderId: string; body: InitiateRefundRequest }> = [];
  nextResponse: RefundResponse = REFUND;

  initiate = (
    ctx: VendorContext,
    orderId: string,
    body: InitiateRefundRequest,
  ): Promise<RefundResponse> => {
    this.calls.push({ ctx, orderId, body });
    return Promise.resolve(this.nextResponse);
  };
}

describe('VendorRefundsController', () => {
  it('initiate forwards the vendor context, orderId, and body to the service', async () => {
    const svc = new FakeRefundsService();
    const controller = new VendorRefundsController(svc as unknown as RefundsService);

    const body: InitiateRefundRequest = {
      amountCents: 2_500,
      reasonCode: 'damaged_packaging',
      reasonNotes: 'Bag torn at handoff',
    };

    const res = await controller.initiate(CTX, ORDER_ID, body);

    expect(res).toEqual({ refund: REFUND });
    expect(svc.calls).toHaveLength(1);
    expect(svc.calls[0]).toEqual({ ctx: CTX, orderId: ORDER_ID, body });
  });

  it('wraps the service response in { refund } without mutation', async () => {
    const svc = new FakeRefundsService();
    const pending: RefundResponse = {
      ...REFUND,
      status: 'pending',
      providerRef: null,
      completedAt: null,
      amountCents: 6_000,
      requiresAdminApproval: true,
    };
    svc.nextResponse = pending;
    const controller = new VendorRefundsController(svc as unknown as RefundsService);

    const res = await controller.initiate(CTX, ORDER_ID, {
      amountCents: 6_000,
      reasonCode: 'customer_complaint',
    });

    expect(res.refund).toBe(pending);
    expect(res.refund.requiresAdminApproval).toBe(true);
    expect(res.refund.status).toBe('pending');
  });
});
