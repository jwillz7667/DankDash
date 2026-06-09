/**
 * NotificationPreferencesController unit tests. The controller is a thin
 * pass-through to NotificationPreferencesService; what we pin here is that the
 * @CurrentUser claim's userId reaches the service and the PATCH body threads
 * through unmodified. The surface has no :id param (self-scoped), so there is
 * no cross-user path to exercise.
 */
import { describe, expect, it } from 'vitest';
import { NotificationPreferencesController } from './notification-preferences.controller.js';
import type {
  NotificationPreferencesResponse,
  UpdateNotificationPreferencesRequest,
} from './dto/index.js';
import type { NotificationPreferencesService } from './notification-preferences.service.js';
import type { AuthenticatedUser } from '../auth/guards/auth-types.js';

const USER: AuthenticatedUser = {
  userId: '01935f3d-0000-7000-8000-000000000001',
  sessionId: '01935f3d-0000-7000-8000-000000000099',
  role: 'customer',
};

const RESPONSE: NotificationPreferencesResponse = {
  orderUpdatesEnabled: true,
  promotionsEnabled: false,
  pushEnabled: true,
  smsEnabled: true,
  emailEnabled: true,
  updatedAt: '2026-05-02T00:00:00.000Z',
};

class FakeNotificationPreferencesService {
  calls = {
    getForUser: [] as string[],
    update: [] as Array<{ userId: string; patch: UpdateNotificationPreferencesRequest }>,
  };

  getForUser = (userId: string): Promise<NotificationPreferencesResponse> => {
    this.calls.getForUser.push(userId);
    return Promise.resolve(RESPONSE);
  };

  update = (
    userId: string,
    patch: UpdateNotificationPreferencesRequest,
  ): Promise<NotificationPreferencesResponse> => {
    this.calls.update.push({ userId, patch });
    return Promise.resolve(RESPONSE);
  };
}

describe('NotificationPreferencesController', () => {
  it('get threads the caller userId through to the service', async () => {
    const svc = new FakeNotificationPreferencesService();
    const controller = new NotificationPreferencesController(
      svc as unknown as NotificationPreferencesService,
    );

    const res = await controller.get(USER);

    expect(res).toBe(RESPONSE);
    expect(svc.calls.getForUser).toEqual([USER.userId]);
  });

  it('update threads userId + body through to the service', async () => {
    const svc = new FakeNotificationPreferencesService();
    const controller = new NotificationPreferencesController(
      svc as unknown as NotificationPreferencesService,
    );

    const res = await controller.update(USER, { promotionsEnabled: false });

    expect(res).toBe(RESPONSE);
    expect(svc.calls.update).toEqual([
      { userId: USER.userId, patch: { promotionsEnabled: false } },
    ]);
  });
});
