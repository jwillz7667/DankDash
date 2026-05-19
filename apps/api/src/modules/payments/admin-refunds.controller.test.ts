/**
 * AdminRefundsController unit tests. Thin pass-through to
 * RefundsService.approve; what we pin here is that the @CurrentUser
 * claim's userId becomes the approver, the :id path param reaches the
 * service, and the response is wrapped as `{ refund }`.
 */
import { describe, expect, it } from 'vitest';
import { AdminRefundsController } from './admin-refunds.controller.js';
import type { RefundResponse } from './dto/index.js';
import type { RefundsService } from './refunds.service.js';
import type { AuthenticatedUser } from '../auth/guards/auth-types.js';

const ADMIN: AuthenticatedUser = {
  userId: '01935f3d-0000-7000-8000-0000000000c0',
  sessionId: '01935f3d-0000-7000-8000-0000000000c9',
  role: 'admin',
};

const REFUND_ID = '01935f3d-0000-7000-8000-0000000000b0';

const COMPLETED: RefundResponse = {
  id: REFUND_ID,
  orderId: '01935f3d-0000-7000-8000-0000000000a0',
  amountCents: 7_500,
  reasonCode: 'customer_complaint',
  reasonNotes: null,
  initiatedBy: '01935f3d-0000-7000-8000-000000000001',
  approvedBy: ADMIN.userId,
  providerRef: 'aeropay_refund_test_2',
  status: 'completed',
  createdAt: '2026-05-18T15:00:00.000Z',
  completedAt: '2026-05-18T15:00:02.000Z',
  requiresAdminApproval: true,
};

class FakeRefundsService {
  calls: Array<{ adminUserId: string; refundId: string }> = [];
  nextResponse: RefundResponse = COMPLETED;

  approve = (adminUserId: string, refundId: string): Promise<RefundResponse> => {
    this.calls.push({ adminUserId, refundId });
    return Promise.resolve(this.nextResponse);
  };
}

describe('AdminRefundsController', () => {
  it('approve forwards the admin userId and refundId to the service', async () => {
    const svc = new FakeRefundsService();
    const controller = new AdminRefundsController(svc as unknown as RefundsService);

    const res = await controller.approve(ADMIN, REFUND_ID);

    expect(res).toEqual({ refund: COMPLETED });
    expect(svc.calls).toEqual([{ adminUserId: ADMIN.userId, refundId: REFUND_ID }]);
  });

  it('wraps the service response in { refund } without mutation', async () => {
    const svc = new FakeRefundsService();
    const controller = new AdminRefundsController(svc as unknown as RefundsService);

    const res = await controller.approve(ADMIN, REFUND_ID);

    expect(res.refund).toBe(COMPLETED);
    expect(res.refund.approvedBy).toBe(ADMIN.userId);
    expect(res.refund.status).toBe('completed');
  });
});
