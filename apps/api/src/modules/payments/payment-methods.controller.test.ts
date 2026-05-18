/**
 * PaymentMethodsController unit tests. The controller is a thin
 * pass-through to PaymentMethodsService; what we pin here is that the
 * @CurrentUser claim's userId reaches the service and the DTO body
 * threads through unmodified.
 */
import { describe, expect, it } from 'vitest';
import { PaymentMethodsController } from './payment-methods.controller.js';
import type { LinkAeropayResponse, ListPaymentMethodsResponse } from './dto/index.js';
import type { PaymentMethodsService } from './payment-methods.service.js';
import type { AuthenticatedUser } from '../auth/guards/auth-types.js';

const USER: AuthenticatedUser = {
  userId: '01935f3d-0000-7000-8000-000000000001',
  sessionId: '01935f3d-0000-7000-8000-000000000099',
  role: 'customer',
};

const LIST_RESPONSE: ListPaymentMethodsResponse = { paymentMethods: [] };
const LINK_RESPONSE: LinkAeropayResponse = {
  paymentMethod: {
    id: '01935f3d-0000-7000-8000-000000000aaa',
    type: 'aeropay_ach',
    aeropayPaymentMethodRef: 'link_session_test_1',
    bankName: null,
    last4: null,
    isDefault: false,
    status: 'pending',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  },
  link: {
    id: 'link_session_test_1',
    hostedUrl: 'https://link.aeropay.com/session/test_1',
    expiresAt: '2026-05-01T03:00:00.000Z',
  },
};

class FakePaymentMethodsService {
  calls = {
    list: [] as string[],
    link: [] as Array<{ userId: string; returnUrl: string }>,
    delete: [] as Array<{ userId: string; paymentMethodId: string }>,
  };

  list = (userId: string): Promise<ListPaymentMethodsResponse> => {
    this.calls.list.push(userId);
    return Promise.resolve(LIST_RESPONSE);
  };

  linkAeropay = (userId: string, returnUrl: string): Promise<LinkAeropayResponse> => {
    this.calls.link.push({ userId, returnUrl });
    return Promise.resolve(LINK_RESPONSE);
  };

  delete = (userId: string, paymentMethodId: string): Promise<void> => {
    this.calls.delete.push({ userId, paymentMethodId });
    return Promise.resolve();
  };
}

describe('PaymentMethodsController', () => {
  it('list threads userId from @CurrentUser to the service', async () => {
    const svc = new FakePaymentMethodsService();
    const controller = new PaymentMethodsController(svc as unknown as PaymentMethodsService);

    const res = await controller.list(USER);

    expect(res).toBe(LIST_RESPONSE);
    expect(svc.calls.list).toEqual([USER.userId]);
  });

  it('link forwards body.returnUrl and userId to the service', async () => {
    const svc = new FakePaymentMethodsService();
    const controller = new PaymentMethodsController(svc as unknown as PaymentMethodsService);

    const res = await controller.link(USER, {
      returnUrl: 'https://app.dankdash.com/link/return',
    });

    expect(res).toBe(LINK_RESPONSE);
    expect(svc.calls.link).toEqual([
      { userId: USER.userId, returnUrl: 'https://app.dankdash.com/link/return' },
    ]);
  });

  it('delete forwards the path param and userId to the service', async () => {
    const svc = new FakePaymentMethodsService();
    const controller = new PaymentMethodsController(svc as unknown as PaymentMethodsService);

    await controller.delete(USER, '01935f3d-0000-7000-8000-000000000aaa');

    expect(svc.calls.delete).toEqual([
      { userId: USER.userId, paymentMethodId: '01935f3d-0000-7000-8000-000000000aaa' },
    ]);
  });
});
