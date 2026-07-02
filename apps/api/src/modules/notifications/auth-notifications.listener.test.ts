/**
 * AuthNotificationsListener test — pins that a UserRegisteredEvent maps to
 * a consumer `auth.welcome` dispatch for the new user, keyed by userId for
 * idempotency, and that the listener never throws.
 */
import { describe, expect, it } from 'vitest';
import { UserRegisteredEvent } from '../auth/user-registered.events.js';
import { AuthNotificationsListener } from './auth-notifications.listener.js';
import {
  type DispatchInput,
  type DispatchOutcome,
  type NotificationDispatcher,
} from './notification-dispatcher.service.js';
import type { NotificationTemplateKey } from '@dankdash/notifications';

const USER_ID = '01935f3d-0000-7000-8000-000000000001';

class FakeDispatcher {
  calls: Array<DispatchInput<NotificationTemplateKey>> = [];
  shouldThrow = false;

  dispatch = <TKey extends NotificationTemplateKey>(
    input: DispatchInput<TKey>,
  ): Promise<DispatchOutcome> => {
    if (this.shouldThrow) throw new TypeError('boom');
    this.calls.push(input);
    return Promise.resolve({ skipped: false, results: [] });
  };
}

function buildListener(dispatcher: FakeDispatcher): AuthNotificationsListener {
  return new AuthNotificationsListener({
    dispatcher: dispatcher as unknown as NotificationDispatcher,
  });
}

describe('AuthNotificationsListener', () => {
  it('dispatches auth.welcome to the new user keyed by userId', async () => {
    const dispatcher = new FakeDispatcher();

    await buildListener(dispatcher).onUserRegistered(
      new UserRegisteredEvent({ userId: USER_ID, firstName: 'Sam' }),
    );

    expect(dispatcher.calls).toEqual([
      {
        userId: USER_ID,
        templateKey: 'auth.welcome',
        payload: { firstName: 'Sam' },
        appVariant: 'consumer',
        idempotencyKey: USER_ID,
      },
    ]);
  });

  it('swallows dispatcher errors so registration is never affected', async () => {
    const dispatcher = new FakeDispatcher();
    dispatcher.shouldThrow = true;

    await expect(
      buildListener(dispatcher).onUserRegistered(
        new UserRegisteredEvent({ userId: USER_ID, firstName: 'Sam' }),
      ),
    ).resolves.toBeUndefined();
  });
});
