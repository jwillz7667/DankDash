/**
 * Membership lookups against Postgres.
 *
 * The JWT only carries (sub, sid, role). To join a vendor room we need to
 * verify the connecting user is on the staff of the claimed dispensary;
 * to join a driver room we need to verify the user owns the claimed
 * driver record. Both lookups are tiny single-row probes that hit indexed
 * unique constraints — well under the 50ms p95 budget.
 *
 * Connections are cached for the lifetime of the realtime pod (one pool
 * shared across every websocket); per-connection lookups are not cached
 * because membership can change (a fired vendor staff member must lose
 * access at the next connect). Cache invalidation across pods is a future
 * concern if the lookup ever becomes hot.
 */
import { dispensaryStaff, drivers, orders } from '@dankdash/db';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database, OrderStatus } from '@dankdash/db';

/**
 * The customer-facing identity of a driver's in-progress delivery, resolved
 * authoritatively from the `orders` row — never from a client payload. Used
 * to route `driver:location` broadcasts to exactly the customer whose order
 * the driver is delivering. {@link MembershipRepository.findActiveDeliveryForDriverUser}.
 */
export interface ActiveDelivery {
  readonly orderId: string;
  readonly customerId: string;
  /** The fulfilling dispensary — routes the driver's location to the
   * vendor's per-order map in addition to the customer. */
  readonly dispensaryId: string;
}

/**
 * Order statuses during which a driver is assigned and physically moving
 * toward or at the customer, so live GPS is meaningful and the customer's
 * "track my driver" view is open. Terminal/pre-assignment statuses are
 * excluded — once delivered/returned/canceled (or a scan has failed and the
 * run is halted) there is no customer who should still receive the location.
 */
const ACTIVE_DELIVERY_STATUSES: readonly OrderStatus[] = [
  'driver_assigned',
  'en_route_pickup',
  'picked_up',
  'en_route_dropoff',
  'arrived_at_dropoff',
  'id_scan_pending',
  'id_scan_passed',
];

export interface MembershipRepository {
  isStaffOfDispensary(userId: string, dispensaryId: string): Promise<boolean>;
  listStaffDispensariesForUser(userId: string): Promise<readonly string[]>;
  isDriver(userId: string, driverId: string): Promise<boolean>;
  findDriverIdForUser(userId: string): Promise<string | null>;
  /**
   * Resolve the order the given driver (identified by their *user* id — the
   * `orders.driver_id` column references `users.id`, set to the accepting
   * driver's user id in dispatch) is currently delivering, plus that order's
   * customer. Returns null when the driver has no active delivery, in which
   * case their location must not be broadcast to anyone.
   */
  findActiveDeliveryForDriverUser(driverUserId: string): Promise<ActiveDelivery | null>;
}

export class DrizzleMembershipRepository implements MembershipRepository {
  constructor(private readonly db: Database) {}

  async isStaffOfDispensary(userId: string, dispensaryId: string): Promise<boolean> {
    const rows = await this.db
      .select({ one: sql<number>`1` })
      .from(dispensaryStaff)
      .where(
        and(
          eq(dispensaryStaff.userId, userId),
          eq(dispensaryStaff.dispensaryId, dispensaryId),
          isNull(dispensaryStaff.removedAt),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async listStaffDispensariesForUser(userId: string): Promise<readonly string[]> {
    const rows = await this.db
      .select({ dispensaryId: dispensaryStaff.dispensaryId })
      .from(dispensaryStaff)
      .where(and(eq(dispensaryStaff.userId, userId), isNull(dispensaryStaff.removedAt)));
    return rows.map((r) => r.dispensaryId);
  }

  async isDriver(userId: string, driverId: string): Promise<boolean> {
    const rows = await this.db
      .select({ one: sql<number>`1` })
      .from(drivers)
      .where(and(eq(drivers.id, driverId), eq(drivers.userId, userId)))
      .limit(1);
    return rows.length > 0;
  }

  async findDriverIdForUser(userId: string): Promise<string | null> {
    const rows = await this.db
      .select({ id: drivers.id })
      .from(drivers)
      .where(eq(drivers.userId, userId))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  async findActiveDeliveryForDriverUser(driverUserId: string): Promise<ActiveDelivery | null> {
    // A driver carries at most one active delivery; if dispatch ever leaves
    // two non-terminal rows assigned, prefer the most recently assigned so a
    // stale row can never shadow the live one. `orders_driver_idx` (partial
    // on driver_id) makes this a single-row index probe.
    const rows = await this.db
      .select({
        orderId: orders.id,
        customerId: orders.userId,
        dispensaryId: orders.dispensaryId,
      })
      .from(orders)
      .where(
        and(
          eq(orders.driverId, driverUserId),
          inArray(orders.status, [...ACTIVE_DELIVERY_STATUSES]),
        ),
      )
      .orderBy(desc(orders.driverAssignedAt))
      .limit(1);
    return rows[0] ?? null;
  }
}
