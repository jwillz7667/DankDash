import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  bytea,
  citext,
  geographyPoint,
  geographyPolygon,
  type GeoPoint,
  type GeoPolygon,
} from './custom-types.js';
import { dispensaryStatus, licenseType, posProvider, staffRole } from './enums.js';
import { users } from './identity.js';

export const dispensaries = pgTable(
  'dispensaries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    legalName: text('legal_name').notNull(),
    dba: text('dba'),
    licenseNumber: text('license_number').notNull().unique(),
    licenseType: licenseType('license_type').notNull(),
    licenseIssuedAt: date('license_issued_at').notNull(),
    licenseExpiresAt: date('license_expires_at').notNull(),
    metrcFacilityId: text('metrc_facility_id'),
    metrcApiKeyEnc: bytea('metrc_api_key_enc'),
    posProvider: posProvider('pos_provider').notNull().default('manual'),
    posCredentialsEnc: bytea('pos_credentials_enc'),
    posLastSyncedAt: timestamp('pos_last_synced_at', { withTimezone: true, mode: 'date' }),
    addressLine1: text('address_line1').notNull(),
    addressLine2: text('address_line2'),
    city: text('city').notNull(),
    region: text('region').notNull(),
    postalCode: text('postal_code').notNull(),
    location: geographyPoint('location').notNull(),
    deliveryPolygon: geographyPolygon('delivery_polygon').notNull(),
    hoursJson: jsonb('hours_json').notNull(),
    phone: text('phone'),
    email: citext('email'),
    logoImageKey: text('logo_image_key'),
    heroImageKey: text('hero_image_key'),
    brandColorHex: text('brand_color_hex'),
    aeropayAccountRef: text('aeropay_account_ref'),
    isAcceptingOrders: boolean('is_accepting_orders').notNull().default(false),
    ratingAvg: numeric('rating_avg', { precision: 3, scale: 2 }),
    ratingCount: integer('rating_count').notNull().default(0),
    status: dispensaryStatus('status').notNull().default('onboarding'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('dispensaries_status_idx')
      .on(table.status)
      .where(sql`${table.deletedAt} IS NULL`),
    // GIST indexes for `location` and `delivery_polygon` are emitted from raw migration SQL.
  ],
);

export const dispensaryStaff = pgTable(
  'dispensary_staff',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dispensaryId: uuid('dispensary_id')
      .notNull()
      .references(() => dispensaries.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    role: staffRole('role').notNull(),
    permissions: jsonb('permissions')
      .notNull()
      .default(sql`'{}'::jsonb`),
    invitedAt: timestamp('invited_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    invitedBy: uuid('invited_by').references(() => users.id),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
    removedAt: timestamp('removed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    unique('dispensary_staff_dispensary_user_uq').on(table.dispensaryId, table.userId),
    index('dispensary_staff_user_idx')
      .on(table.userId)
      .where(sql`${table.removedAt} IS NULL`),
    index('dispensary_staff_dispensary_idx')
      .on(table.dispensaryId)
      .where(sql`${table.removedAt} IS NULL`),
  ],
);

type DispensaryDbRow = typeof dispensaries.$inferSelect;
/**
 * Public `Dispensary` shape — geo columns surface as parsed GeoJSON value
 * types, not the raw WKB hex string the postgres driver returns. The repo
 * SELECTs project `location` and `delivery_polygon` through `ST_AsGeoJSON`
 * and `parsePoint` / `parsePolygon` inflates them on the read path.
 */
export type Dispensary = Omit<DispensaryDbRow, 'location' | 'deliveryPolygon'> & {
  readonly location: GeoPoint;
  readonly deliveryPolygon: GeoPolygon;
};
export type NewDispensary = typeof dispensaries.$inferInsert;
export type DispensaryStaffMember = typeof dispensaryStaff.$inferSelect;
export type NewDispensaryStaffMember = typeof dispensaryStaff.$inferInsert;
