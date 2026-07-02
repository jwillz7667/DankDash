import { DomainError, type ErrorDetails } from '@dankdash/types';
import type { OrderEventType } from './events.js';
import type { OrderState } from './states.js';

export type OrderErrorCode =
  | 'ORDER_INVALID_TRANSITION'
  | 'ORDER_TERMINAL_STATE'
  | 'ORDER_STATE_UNKNOWN'
  | 'ORDER_NOT_FOUND'
  | 'ORDER_ACTOR_FORBIDDEN'
  | 'ORDER_CANCEL_TOO_LATE'
  | 'ORDER_RATE_NOT_DELIVERED'
  | 'ORDER_ALREADY_RATED'
  | 'ORDER_RATING_OUT_OF_RANGE'
  | 'ORDER_INVARIANT_BROKEN';

/**
 * Stable HTTP mapping for every order-domain error. 422 covers business-rule
 * failures the caller can correct (illegal transition, cancel-too-late);
 * 403 covers actor-authorization failures (vendor B trying to accept
 * dispensary A's order); 404 covers missing rows; 409 covers idempotency
 * conflicts (re-rating an already-rated order); 500 covers programmer
 * bugs where the DB enum and state machine have drifted out of sync.
 */
const ORDER_STATUS_CODES: Readonly<Record<OrderErrorCode, number>> = {
  ORDER_INVALID_TRANSITION: 422,
  ORDER_TERMINAL_STATE: 422,
  ORDER_STATE_UNKNOWN: 500,
  ORDER_NOT_FOUND: 404,
  ORDER_ACTOR_FORBIDDEN: 403,
  ORDER_CANCEL_TOO_LATE: 422,
  ORDER_RATE_NOT_DELIVERED: 422,
  ORDER_ALREADY_RATED: 409,
  ORDER_RATING_OUT_OF_RANGE: 422,
  ORDER_INVARIANT_BROKEN: 500,
};

export class OrderError extends DomainError {
  public readonly code: OrderErrorCode;
  public readonly statusCode: number;

  constructor(code: OrderErrorCode, message: string, details: ErrorDetails = {}, cause?: unknown) {
    super(message, details, cause);
    this.code = code;
    this.statusCode = ORDER_STATUS_CODES[code];
  }

  static invalidTransition(from: OrderState, event: OrderEventType): OrderError {
    return new OrderError(
      'ORDER_INVALID_TRANSITION',
      `Cannot apply event ${event} when order is in state '${from}'`,
      { from, event },
    );
  }

  static terminalState(state: OrderState, event: OrderEventType): OrderError {
    return new OrderError(
      'ORDER_TERMINAL_STATE',
      `Order is in terminal state '${state}'; event ${event} cannot be applied`,
      { state, event },
    );
  }

  static stateUnknown(state: string): OrderError {
    return new OrderError(
      'ORDER_STATE_UNKNOWN',
      `Unknown order state '${state}' — DB enum and state machine are out of sync`,
      { state },
    );
  }

  static notFound(orderId: string): OrderError {
    return new OrderError('ORDER_NOT_FOUND', 'order not found', { orderId });
  }

  static actorForbidden(reason: string, details: ErrorDetails = {}): OrderError {
    return new OrderError('ORDER_ACTOR_FORBIDDEN', reason, details);
  }

  static cancelTooLate(state: OrderState): OrderError {
    return new OrderError(
      'ORDER_CANCEL_TOO_LATE',
      `Customer cancel only permitted before vendor acceptance; order is in '${state}'`,
      { state },
    );
  }

  static rateNotDelivered(state: OrderState): OrderError {
    return new OrderError(
      'ORDER_RATE_NOT_DELIVERED',
      `Ratings can only be recorded after delivery; order is in '${state}'`,
      { state },
    );
  }

  /**
   * The customer has already rated this order. Rating is one-shot: the
   * write amends the delivered order once and feeds the driver/dispensary
   * rating aggregates exactly once, so a second attempt is rejected with
   * 409 rather than silently re-stamping `rated_at` and double-counting
   * the aggregate.
   */
  static alreadyRated(orderId: string): OrderError {
    return new OrderError('ORDER_ALREADY_RATED', 'order has already been rated', { orderId });
  }

  static ratingOutOfRange(field: string, value: number): OrderError {
    return new OrderError('ORDER_RATING_OUT_OF_RANGE', `${field} must be between 1 and 5`, {
      field,
      value,
    });
  }

  /**
   * "This should never happen." Reserved for guarding paths that are
   * structurally unreachable — the resolver always sets the holder before
   * the repo commits, an `applyTransition` success must produce a status
   * snapshot, etc. Surfaces as 500 so the iOS / portal client knows it is
   * a server bug rather than a user-correctable failure, while still
   * carrying enough detail for the on-call to triage from the structured
   * log line. Never throw this to gloss over a known failure mode.
   */
  static invariantBroken(reason: string, details: ErrorDetails = {}): OrderError {
    return new OrderError('ORDER_INVARIANT_BROKEN', reason, details);
  }
}
