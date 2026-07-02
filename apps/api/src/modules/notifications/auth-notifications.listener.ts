/**
 * Listens for `USER_REGISTERED_EVENT` (emitted by AuthService when a new
 * consumer account is created) and dispatches the `auth.welcome`
 * notification — the onboarding email + in_app greeting.
 *
 * The event carries the user id + first name directly, so this listener is
 * a thin translation from the auth domain event to the notification
 * dispatch. `auth.welcome` is an `account` category (non-suppressible), so
 * it is always delivered. Errors are swallowed and logged — the account is
 * already created when the event fires.
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { USER_REGISTERED_EVENT, UserRegisteredEvent } from '../auth/user-registered.events.js';
import { NotificationDispatcher } from './notification-dispatcher.service.js';

export interface AuthNotificationsListenerDeps {
  readonly dispatcher: NotificationDispatcher;
}

@Injectable()
export class AuthNotificationsListener {
  private readonly logger = new Logger(AuthNotificationsListener.name);

  constructor(private readonly deps: AuthNotificationsListenerDeps) {}

  @OnEvent(USER_REGISTERED_EVENT, { suppressErrors: true })
  async onUserRegistered(event: UserRegisteredEvent): Promise<void> {
    try {
      await this.deps.dispatcher.dispatch({
        userId: event.userId,
        templateKey: 'auth.welcome',
        payload: { firstName: event.firstName },
        appVariant: 'consumer',
        idempotencyKey: event.userId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `welcome notification failed for user ${event.userId}: ${message}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }
}
