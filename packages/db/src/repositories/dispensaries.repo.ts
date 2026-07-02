import { RepositoryError } from '@dankdash/types';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { type GeoPoint, type GeoPolygon } from '../schema/custom-types.js';
import {
  dispensaries,
  dispensaryStaff,
  type Dispensary,
  type DispensaryStaffMember,
  type NewDispensary,
  type NewDispensaryStaffMember,
} from '../schema/dispensaries.js';
import { type StaffRole } from '../schema/enums.js';
import { parsePoint, parsePolygon, pointToSql, polygonToSql } from '../schema/geo.js';
import { users } from '../schema/identity.js';
import { BaseRepository, newId } from './base.js';

/**
 * Wire shape for a staff row joined with the underlying user. The portal
 * staff page reads every field except `permissions` (Phase 15.4 surfaces a
 * fixed role grid; per-permission overrides land later). `removedAt` is
 * carried so the portal can render a "Removed" row when an operator wants
 * historic context — actively filtering it out on the SQL side would hide
 * the trail an owner needs to audit who used to have access.
 */
export interface StaffWithUserRow {
  readonly id: string;
  readonly dispensaryId: string;
  readonly userId: string;
  readonly role: StaffRole;
  readonly invitedAt: Date;
  readonly invitedBy: string | null;
  readonly acceptedAt: Date | null;
  readonly removedAt: Date | null;
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly mfaEnabled: boolean;
  readonly lastLoginAt: Date | null;
}

export interface CreateDispensaryInput extends Omit<NewDispensary, 'location' | 'deliveryPolygon'> {
  readonly location: GeoPoint;
  readonly deliveryPolygon: GeoPolygon;
}

interface DispensaryRow extends Omit<Dispensary, 'location' | 'deliveryPolygon'> {
  readonly location: string;
  readonly deliveryPolygon: string;
}

const LOCATION_SQL = sql<string>`ST_AsGeoJSON(${dispensaries.location})`;
const POLYGON_SQL = sql<string>`ST_AsGeoJSON(${dispensaries.deliveryPolygon})`;

const SELECT_COLUMNS = {
  id: dispensaries.id,
  legalName: dispensaries.legalName,
  dba: dispensaries.dba,
  licenseNumber: dispensaries.licenseNumber,
  licenseType: dispensaries.licenseType,
  licenseIssuedAt: dispensaries.licenseIssuedAt,
  licenseExpiresAt: dispensaries.licenseExpiresAt,
  metrcFacilityId: dispensaries.metrcFacilityId,
  metrcApiKeyEnc: dispensaries.metrcApiKeyEnc,
  posProvider: dispensaries.posProvider,
  posCredentialsEnc: dispensaries.posCredentialsEnc,
  posLastSyncedAt: dispensaries.posLastSyncedAt,
  addressLine1: dispensaries.addressLine1,
  addressLine2: dispensaries.addressLine2,
  city: dispensaries.city,
  region: dispensaries.region,
  postalCode: dispensaries.postalCode,
  location: LOCATION_SQL,
  deliveryPolygon: POLYGON_SQL,
  hoursJson: dispensaries.hoursJson,
  phone: dispensaries.phone,
  email: dispensaries.email,
  logoImageKey: dispensaries.logoImageKey,
  heroImageKey: dispensaries.heroImageKey,
  brandColorHex: dispensaries.brandColorHex,
  aeropayAccountRef: dispensaries.aeropayAccountRef,
  isAcceptingOrders: dispensaries.isAcceptingOrders,
  ratingAvg: dispensaries.ratingAvg,
  ratingCount: dispensaries.ratingCount,
  status: dispensaries.status,
  createdAt: dispensaries.createdAt,
  updatedAt: dispensaries.updatedAt,
  deletedAt: dispensaries.deletedAt,
} as const;

function inflateDispensary(row: DispensaryRow): Dispensary {
  return {
    ...row,
    location: parsePoint(row.location),
    deliveryPolygon: parsePolygon(row.deliveryPolygon),
  };
}

export class DispensariesRepository extends BaseRepository {
  async findById(id: string): Promise<Dispensary | null> {
    const [row] = await this.db
      .select(SELECT_COLUMNS)
      .from(dispensaries)
      .where(eq(dispensaries.id, id))
      .limit(1);
    return row === undefined ? null : inflateDispensary(row);
  }

  async findByLicenseNumber(licenseNumber: string): Promise<Dispensary | null> {
    const [row] = await this.db
      .select(SELECT_COLUMNS)
      .from(dispensaries)
      .where(eq(dispensaries.licenseNumber, licenseNumber))
      .limit(1);
    return row === undefined ? null : inflateDispensary(row);
  }

  async listActive(): Promise<readonly Dispensary[]> {
    const rows = await this.db
      .select(SELECT_COLUMNS)
      .from(dispensaries)
      .where(and(eq(dispensaries.status, 'active'), isNull(dispensaries.deletedAt)));
    return rows.map((row) => inflateDispensary(row));
  }

  async listDeliveringTo(point: GeoPoint): Promise<readonly Dispensary[]> {
    const pointExpr = pointToSql(point);
    const rows = await this.db
      .select(SELECT_COLUMNS)
      .from(dispensaries)
      .where(
        and(
          eq(dispensaries.status, 'active'),
          eq(dispensaries.isAcceptingOrders, true),
          isNull(dispensaries.deletedAt),
          sql`ST_Contains(${dispensaries.deliveryPolygon}::geometry, ${pointExpr}::geometry)`,
        ),
      );
    return rows.map((row) => inflateDispensary(row));
  }

  async create(input: CreateDispensaryInput): Promise<Dispensary> {
    const id = input.id ?? newId();
    const [inserted] = await this.db
      .insert(dispensaries)
      .values({
        ...input,
        id,
        location: pointToSql(input.location),
        deliveryPolygon: polygonToSql(input.deliveryPolygon),
      })
      .returning({ id: dispensaries.id });
    if (inserted === undefined) throw new RepositoryError('dispensaries insert returned no row');
    const row = await this.findById(inserted.id);
    if (row === null)
      throw new RepositoryError(`dispensaries ${inserted.id} disappeared after insert`);
    return row;
  }

  async setAcceptingOrders(id: string, accepting: boolean): Promise<void> {
    await this.db
      .update(dispensaries)
      .set({ isAcceptingOrders: accepting, updatedAt: new Date() })
      .where(eq(dispensaries.id, id));
  }

  /**
   * Partial admin update. Identity-shaped fields (id, createdAt, deletedAt,
   * licenseNumber) and the status/location write paths are excluded from
   * `patch` — those go through `updateStatus` / dedicated geo setters so the
   * audit trail stays specific. `deliveryPolygon` is accepted as GeoJSON and
   * wrapped through `polygonToSql` here (never spread raw into `.set()`,
   * which would write GeoJSON text to the geography column).
   *
   * Returns `null` when no row matches the id (caller turns this into 404).
   */
  async update(
    id: string,
    patch: Partial<
      Omit<
        NewDispensary,
        | 'id'
        | 'createdAt'
        | 'updatedAt'
        | 'deletedAt'
        | 'licenseNumber'
        | 'status'
        | 'location'
        | 'deliveryPolygon'
      >
    > & { readonly deliveryPolygon?: GeoPolygon },
  ): Promise<Dispensary | null> {
    const { deliveryPolygon, ...columns } = patch;
    const [updated] = await this.db
      .update(dispensaries)
      .set({
        ...columns,
        ...(deliveryPolygon !== undefined
          ? { deliveryPolygon: polygonToSql(deliveryPolygon) }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(dispensaries.id, id))
      .returning({ id: dispensaries.id });
    if (updated === undefined) return null;
    return this.findById(updated.id);
  }

  async updateStatus(id: string, status: Dispensary['status']): Promise<Dispensary | null> {
    const [updated] = await this.db
      .update(dispensaries)
      .set({ status, updatedAt: new Date() })
      .where(eq(dispensaries.id, id))
      .returning({ id: dispensaries.id });
    if (updated === undefined) return null;
    return this.findById(updated.id);
  }

  /**
   * Fold one post-delivery rating into the running dispensary aggregate.
   * The new average is computed on the row itself in a single UPDATE —
   * `newAvg = (avg * count + rating) / (count + 1)` — never read-modify-
   * written in JS, so concurrent ratings on the same dispensary serialise
   * on the row lock and cannot lose an increment. The arithmetic runs in
   * Postgres `numeric` (rating_avg is `NUMERIC(3,2)`, count is `integer`),
   * so there is no float rounding; `round(…, 2)` pins the stored scale.
   * Feeds `dispensaries.rating_avg`/`rating_count`, which the dispatch
   * scorer and menu ranking read. Callers must scope this to one rating
   * per order (the `rated_at` one-shot guard) so no rating is folded twice.
   */
  async applyRating(id: string, rating: number): Promise<void> {
    await this.db
      .update(dispensaries)
      .set({
        ratingAvg: sql`round((coalesce(${dispensaries.ratingAvg}, 0) * ${dispensaries.ratingCount} + ${rating}) / (${dispensaries.ratingCount} + 1), 2)`,
        ratingCount: sql`${dispensaries.ratingCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(dispensaries.id, id));
  }
}

export class DispensaryStaffRepository extends BaseRepository {
  async findByDispensaryAndUser(
    dispensaryId: string,
    userId: string,
  ): Promise<DispensaryStaffMember | null> {
    const [row] = await this.db
      .select()
      .from(dispensaryStaff)
      .where(
        and(eq(dispensaryStaff.dispensaryId, dispensaryId), eq(dispensaryStaff.userId, userId)),
      )
      .limit(1);
    return row ?? null;
  }

  async listActiveForDispensary(dispensaryId: string): Promise<readonly DispensaryStaffMember[]> {
    return this.db
      .select()
      .from(dispensaryStaff)
      .where(
        and(eq(dispensaryStaff.dispensaryId, dispensaryId), isNull(dispensaryStaff.removedAt)),
      );
  }

  async listActiveForUser(userId: string): Promise<readonly DispensaryStaffMember[]> {
    return this.db
      .select()
      .from(dispensaryStaff)
      .where(and(eq(dispensaryStaff.userId, userId), isNull(dispensaryStaff.removedAt)));
  }

  /**
   * Staff roster joined with the underlying users row. Used by the
   * vendor-portal staff page (Phase 15.4) — returns every membership the
   * dispensary has ever held (active and removed) so the operator can see
   * who used to have access. Ordered: active first (removedAt NULL), then
   * by invitedAt desc within each group, so the most recent invite is at
   * the top of the list.
   */
  async listWithUserForDispensary(dispensaryId: string): Promise<readonly StaffWithUserRow[]> {
    const rows = await this.db
      .select({
        id: dispensaryStaff.id,
        dispensaryId: dispensaryStaff.dispensaryId,
        userId: dispensaryStaff.userId,
        role: dispensaryStaff.role,
        invitedAt: dispensaryStaff.invitedAt,
        invitedBy: dispensaryStaff.invitedBy,
        acceptedAt: dispensaryStaff.acceptedAt,
        removedAt: dispensaryStaff.removedAt,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        mfaEnabled: users.mfaEnabled,
        lastLoginAt: users.lastLoginAt,
      })
      .from(dispensaryStaff)
      .innerJoin(users, eq(users.id, dispensaryStaff.userId))
      .where(eq(dispensaryStaff.dispensaryId, dispensaryId))
      .orderBy(sql`${dispensaryStaff.removedAt} IS NOT NULL`, desc(dispensaryStaff.invitedAt));
    return rows;
  }

  async findById(id: string): Promise<DispensaryStaffMember | null> {
    const [row] = await this.db
      .select()
      .from(dispensaryStaff)
      .where(eq(dispensaryStaff.id, id))
      .limit(1);
    return row ?? null;
  }

  async invite(
    input: Omit<NewDispensaryStaffMember, 'id'> & { readonly id?: string },
  ): Promise<DispensaryStaffMember> {
    const [row] = await this.db
      .insert(dispensaryStaff)
      .values({ ...input, id: input.id ?? newId() })
      .returning();
    if (row === undefined) throw new RepositoryError('dispensary_staff insert returned no row');
    return row;
  }

  async updateRole(id: string, role: StaffRole): Promise<DispensaryStaffMember | null> {
    const [row] = await this.db
      .update(dispensaryStaff)
      .set({ role })
      .where(eq(dispensaryStaff.id, id))
      .returning();
    return row ?? null;
  }

  async accept(id: string, at: Date): Promise<void> {
    await this.db.update(dispensaryStaff).set({ acceptedAt: at }).where(eq(dispensaryStaff.id, id));
  }

  async remove(id: string, at: Date): Promise<void> {
    await this.db.update(dispensaryStaff).set({ removedAt: at }).where(eq(dispensaryStaff.id, id));
  }

  /**
   * Count of staff at a given role that are still active. The staff
   * service uses this for the "don't remove the last owner" invariant —
   * demoting or removing the last active owner would lock the dispensary
   * out of owner-only operations forever.
   */
  async countActiveByRole(dispensaryId: string, role: StaffRole): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(dispensaryStaff)
      .where(
        and(
          eq(dispensaryStaff.dispensaryId, dispensaryId),
          eq(dispensaryStaff.role, role),
          isNull(dispensaryStaff.removedAt),
        ),
      );
    return row?.count ?? 0;
  }
}
