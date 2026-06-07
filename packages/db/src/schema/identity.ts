import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, citext, geographyPoint, inet, type GeoPoint } from './custom-types.js';
import { idDocumentType, userRole, userStatus } from './enums.js';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: citext('email').notNull().unique(),
    phone: text('phone').unique(),
    passwordHash: text('password_hash').notNull(),
    role: userRole('role').notNull().default('customer'),
    status: userStatus('status').notNull().default('pending_kyc'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    dateOfBirth: date('date_of_birth'),
    kycVerifiedAt: timestamp('kyc_verified_at', { withTimezone: true, mode: 'date' }),
    kycProvider: text('kyc_provider'),
    kycProviderRef: text('kyc_provider_ref'),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    mfaSecretEnc: bytea('mfa_secret_enc'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    check(
      'users_phone_format',
      sql`${table.phone} IS NULL OR ${table.phone} ~ '^\\+[1-9]\\d{1,14}$'`,
    ),
    check(
      'users_dob_realistic',
      sql`${table.dateOfBirth} IS NULL OR ${table.dateOfBirth} > '1900-01-01'`,
    ),
    index('users_role_status_idx')
      .on(table.role, table.status)
      .where(sql`${table.deletedAt} IS NULL`),
    index('users_phone_idx')
      .on(table.phone)
      .where(sql`${table.phone} IS NOT NULL`),
  ],
);

export const userAddresses = pgTable(
  'user_addresses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label'),
    line1: text('line1').notNull(),
    line2: text('line2'),
    city: text('city').notNull(),
    region: text('region').notNull(),
    postalCode: text('postal_code').notNull(),
    country: text('country').notNull().default('US'),
    location: geographyPoint('location').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    isValidated: boolean('is_validated').notNull().default(false),
    validatedAt: timestamp('validated_at', { withTimezone: true, mode: 'date' }),
    deliveryInstructions: text('delivery_instructions'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('user_addresses_user_idx')
      .on(table.userId)
      .where(sql`${table.deletedAt} IS NULL`),
    // Spatial GIST index — emitted in raw migration SQL, not declared here.
    uniqueIndex('user_addresses_one_default')
      .on(table.userId)
      .where(sql`${table.isDefault} = true AND ${table.deletedAt} IS NULL`),
  ],
);

export const userIdDocuments = pgTable(
  'user_id_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    type: idDocumentType('type').notNull(),
    issuingRegion: text('issuing_region'),
    documentNumberHash: bytea('document_number_hash').notNull(),
    scanImageKey: text('scan_image_key'),
    selfieImageKey: text('selfie_image_key'),
    verified: boolean('verified').notNull().default(false),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
    expiresAt: date('expires_at'),
    verificationProvider: text('verification_provider'),
    verificationRef: text('verification_ref'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('user_id_documents_user_idx').on(table.userId)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // All session rows descended from the same login share a familyId.
    // Refresh-token reuse detection invalidates the entire family —
    // see docs/runbooks/refresh-token-reuse.md.
    familyId: uuid('family_id').notNull(),
    refreshTokenHash: bytea('refresh_token_hash').notNull().unique(),
    deviceId: text('device_id'),
    deviceFingerprint: jsonb('device_fingerprint'),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true, mode: 'date' }),
    rotatedTo: uuid('rotated_to'),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('sessions_user_idx')
      .on(table.userId)
      .where(sql`${table.revokedAt} IS NULL`),
    index('sessions_expires_idx')
      .on(table.expiresAt)
      .where(sql`${table.revokedAt} IS NULL`),
    index('sessions_family_idx')
      .on(table.familyId)
      .where(sql`${table.revokedAt} IS NULL`),
    check(
      'sessions_rotation_consistent',
      sql`(${table.rotatedAt} IS NULL) = (${table.rotatedTo} IS NULL)`,
    ),
  ],
);

/**
 * Email-delivered password-reset tokens.
 *
 * The user receives a high-entropy code by email; we never store the code
 * itself — only its SHA-256 (`code_hash`, a bytea mirroring the
 * `sessions.refresh_token_hash` pattern). Lookups are by hash, so the unique
 * constraint also guarantees at most one row per code.
 *
 * Defence in depth against a stolen/guessed code:
 *   - high entropy — the code is 60 bits of CSPRNG output, so an online guess
 *                    effectively never finds a row and an offline grind of the
 *                    hash cannot finish inside the TTL.
 *   - `expires_at` — short TTL (the service uses 15 minutes).
 *   - `used_at`    — single-use; also stamped on every still-active token for
 *                    a user when they request a fresh one, so a superseded
 *                    code can never be redeemed.
 *
 * `user_id` cascade-deletes with the account. `requested_ip` is retained for
 * abuse triage only and is never surfaced to clients.
 */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: bytea('code_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
    requestedIp: inet('requested_ip'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('password_reset_tokens_user_active_idx')
      .on(table.userId)
      .where(sql`${table.usedAt} IS NULL`),
    index('password_reset_tokens_expires_idx')
      .on(table.expiresAt)
      .where(sql`${table.usedAt} IS NULL`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

type UserAddressDbRow = typeof userAddresses.$inferSelect;
/**
 * Public `UserAddress` shape — `location` surfaces as a typed GeoPoint
 * because the repo projects the column through `ST_AsGeoJSON` and parses it
 * before returning. Inserts go through {@link CreateUserAddressInput} which
 * accepts the same GeoPoint shape.
 */
export type UserAddress = Omit<UserAddressDbRow, 'location'> & {
  readonly location: GeoPoint;
};
export type NewUserAddress = typeof userAddresses.$inferInsert;
export type UserIdDocument = typeof userIdDocuments.$inferSelect;
export type NewUserIdDocument = typeof userIdDocuments.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert;
