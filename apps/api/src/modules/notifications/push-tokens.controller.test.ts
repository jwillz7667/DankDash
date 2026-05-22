/**
 * PushTokensController unit tests. The controller is a thin pass-through
 * to PushTokensService; what we pin here is that the @CurrentUser claim's
 * userId reaches the service and the DTO body threads through unmodified.
 */
import { describe, expect, it } from 'vitest';
import { PushTokensController } from './push-tokens.controller.js';
import type { RegisterPushTokenRequest, RegisterPushTokenResponse } from './dto/index.js';
import type { PushTokensService } from './push-tokens.service.js';
import type { AuthenticatedUser } from '../auth/guards/auth-types.js';

const USER: AuthenticatedUser = {
  userId: '01935f3d-0000-7000-8000-000000000001',
  sessionId: '01935f3d-0000-7000-8000-000000000099',
  role: 'customer',
};

const APNS_TOKEN = 'a'.repeat(64);

const RESPONSE: RegisterPushTokenResponse = {
  pushToken: {
    id: '01935f3d-0000-7000-8000-0000000000aa',
    deviceId: 'idfv-test',
    platform: 'ios',
    appVariant: 'consumer',
    isActive: true,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  },
};

class FakePushTokensService {
  calls = {
    register: [] as Array<{ userId: string; input: RegisterPushTokenRequest }>,
    deactivate: [] as Array<{ userId: string; id: string }>,
  };

  register = (
    userId: string,
    input: RegisterPushTokenRequest,
  ): Promise<RegisterPushTokenResponse> => {
    this.calls.register.push({ userId, input });
    return Promise.resolve(RESPONSE);
  };

  deactivate = (userId: string, id: string): Promise<void> => {
    this.calls.deactivate.push({ userId, id });
    return Promise.resolve();
  };
}

describe('PushTokensController', () => {
  it('register threads userId + body through to the service', async () => {
    const svc = new FakePushTokensService();
    const controller = new PushTokensController(svc as unknown as PushTokensService);

    const res = await controller.register(USER, {
      deviceId: 'idfv-test',
      apnsToken: APNS_TOKEN,
      platform: 'ios',
      appVariant: 'consumer',
    });

    expect(res).toBe(RESPONSE);
    expect(svc.calls.register).toEqual([
      {
        userId: USER.userId,
        input: {
          deviceId: 'idfv-test',
          apnsToken: APNS_TOKEN,
          platform: 'ios',
          appVariant: 'consumer',
        },
      },
    ]);
  });

  it('delete forwards the path param and userId to the service', async () => {
    const svc = new FakePushTokensService();
    const controller = new PushTokensController(svc as unknown as PushTokensService);

    await controller.delete(USER, '01935f3d-0000-7000-8000-0000000000aa');

    expect(svc.calls.deactivate).toEqual([
      { userId: USER.userId, id: '01935f3d-0000-7000-8000-0000000000aa' },
    ]);
  });
});
