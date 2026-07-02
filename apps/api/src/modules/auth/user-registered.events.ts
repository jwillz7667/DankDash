/**
 * Domain event emitted by AuthService the moment a new consumer account is
 * durably created (before tokens are issued). Order creation is an INSERT
 * with no transition, so there is no lifecycle event to hang the welcome
 * notification off — this dedicated event is the signal.
 *
 * Consumed by `AuthNotificationsListener` (apps/api/src/modules/
 * notifications), which dispatches the `auth.welcome` notification. Carries
 * the user id + first name directly so the listener never re-reads the
 * users row. Emitted post-create; a subscriber failure must not fail the
 * registration response, which is already durable.
 */

export const USER_REGISTERED_EVENT = 'user.registered';

export interface UserRegisteredEventPayload {
  readonly userId: string;
  readonly firstName: string;
}

export class UserRegisteredEvent implements UserRegisteredEventPayload {
  public readonly userId: string;
  public readonly firstName: string;

  constructor(payload: UserRegisteredEventPayload) {
    this.userId = payload.userId;
    this.firstName = payload.firstName;
  }
}
