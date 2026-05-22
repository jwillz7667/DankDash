/**
 * Shape of the driver-scoped context the DriverContextGuard attaches to
 * the request. Kept in its own file so the decorator, guard, controller,
 * and downstream services can import it without creating a cycle.
 *
 * `driverId` is the `drivers.id` PK (not the `users.id` of the principal).
 * Most driver-surface SQL keys on `drivers.id` because that is what the
 * `drivers.user_id` FK resolves to and what `dispatch_offers.driver_id`
 * references — carrying both in the context lets handler code pick the
 * right key without re-fetching the row.
 */
import type { DriverStatus } from '@dankdash/db';

export interface DriverContext {
  readonly driverId: string;
  readonly userId: string;
  readonly currentStatus: DriverStatus;
  readonly currentOrderId: string | null;
}

export const DRIVER_CONTEXT_REQUEST_KEY = 'dankdash:driverContext';
