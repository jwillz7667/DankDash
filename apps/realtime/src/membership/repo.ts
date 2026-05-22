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
import { dispensaryStaff, drivers } from '@dankdash/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '@dankdash/db';

export interface MembershipRepository {
  isStaffOfDispensary(userId: string, dispensaryId: string): Promise<boolean>;
  listStaffDispensariesForUser(userId: string): Promise<readonly string[]>;
  isDriver(userId: string, driverId: string): Promise<boolean>;
  findDriverIdForUser(userId: string): Promise<string | null>;
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
}
