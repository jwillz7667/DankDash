import { RepositoryError } from '@dankdash/types';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { type GeoPoint, type GeoPolygon } from '../schema/custom-types.js';
import {
  dispensaries,
  dispensaryStaff,
  type Dispensary,
  type DispensaryStaffMember,
  type NewDispensary,
  type NewDispensaryStaffMember,
} from '../schema/dispensaries.js';
import { parsePoint, parsePolygon, pointToSql, polygonToSql } from '../schema/geo.js';
import { BaseRepository, newId } from './base.js';

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

  async updateStatus(id: string, status: Dispensary['status']): Promise<Dispensary | null> {
    const [updated] = await this.db
      .update(dispensaries)
      .set({ status, updatedAt: new Date() })
      .where(eq(dispensaries.id, id))
      .returning({ id: dispensaries.id });
    if (updated === undefined) return null;
    return this.findById(updated.id);
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

  async accept(id: string, at: Date): Promise<void> {
    await this.db.update(dispensaryStaff).set({ acceptedAt: at }).where(eq(dispensaryStaff.id, id));
  }

  async remove(id: string, at: Date): Promise<void> {
    await this.db.update(dispensaryStaff).set({ removedAt: at }).where(eq(dispensaryStaff.id, id));
  }
}
