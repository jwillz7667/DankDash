import { RepositoryError } from '@dankdash/types';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { type GeoPoint } from '../schema/custom-types.js';
import { parsePoint, pointToSql } from '../schema/geo.js';
import {
  passwordResetTokens,
  sessions,
  type NewPasswordResetToken,
  type NewSession,
  type NewUser,
  type NewUserAddress,
  type NewUserIdDocument,
  type PasswordResetToken,
  type Session,
  type User,
  type UserAddress,
  type UserIdDocument,
  userAddresses,
  userIdDocuments,
  users,
} from '../schema/identity.js';
import { BaseRepository, newId } from './base.js';

export interface CreateUserAddressInput extends Omit<NewUserAddress, 'location'> {
  readonly location: GeoPoint;
}

/**
 * Fields that PATCH /v1/addresses/:id is permitted to mutate. `isDefault` is
 * intentionally excluded — flipping the singleton requires the atomic
 * `setDefault` transaction so two rows can never race to both be default.
 * System-managed fields (`isValidated`, `validatedAt`, `deletedAt`, `userId`,
 * `id`, timestamps) are excluded so callers cannot forge them through the
 * patch surface.
 */
export type UpdateUserAddressPatch = Partial<{
  readonly label: NewUserAddress['label'];
  readonly line1: NewUserAddress['line1'];
  readonly line2: NewUserAddress['line2'];
  readonly city: NewUserAddress['city'];
  readonly region: NewUserAddress['region'];
  readonly postalCode: NewUserAddress['postalCode'];
  readonly country: NewUserAddress['country'];
  readonly location: GeoPoint;
  readonly deliveryInstructions: NewUserAddress['deliveryInstructions'];
}>;

interface UserAddressRow extends Omit<UserAddress, 'location'> {
  readonly location: string;
}

const ADDRESS_LOCATION_SQL = sql<string>`ST_AsGeoJSON(${userAddresses.location})`;

function inflateAddress(row: UserAddressRow): UserAddress {
  return { ...row, location: parsePoint(row.location) };
}

export class UsersRepository extends BaseRepository {
  async findById(id: string): Promise<User | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return row ?? null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const [row] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    return row ?? null;
  }

  async findByPhone(phone: string): Promise<User | null> {
    const [row] = await this.db.select().from(users).where(eq(users.phone, phone)).limit(1);
    return row ?? null;
  }

  async create(input: Omit<NewUser, 'id'> & { readonly id?: string }): Promise<User> {
    const [row] = await this.db
      .insert(users)
      .values({ ...input, id: input.id ?? newId() })
      .returning();
    if (row === undefined) throw new RepositoryError('users insert returned no row');
    return row;
  }

  async update(
    id: string,
    patch: Partial<Omit<NewUser, 'id' | 'createdAt'>>,
  ): Promise<User | null> {
    const [row] = await this.db
      .update(users)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    return row ?? null;
  }

  async markKycVerified(id: string, provider: string, providerRef: string): Promise<User | null> {
    return this.update(id, {
      kycVerifiedAt: new Date(),
      kycProvider: provider,
      kycProviderRef: providerRef,
      status: 'active',
    });
  }

  async recordLogin(id: string, at: Date): Promise<void> {
    await this.db
      .update(users)
      .set({ lastLoginAt: at, updatedAt: new Date() })
      .where(eq(users.id, id));
  }

  async softDelete(id: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(users)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(users.id, id), isNull(users.deletedAt)));
  }
}

export class UserAddressesRepository extends BaseRepository {
  async findById(id: string): Promise<UserAddress | null> {
    const rows = await this.db
      .select({
        id: userAddresses.id,
        userId: userAddresses.userId,
        label: userAddresses.label,
        line1: userAddresses.line1,
        line2: userAddresses.line2,
        city: userAddresses.city,
        region: userAddresses.region,
        postalCode: userAddresses.postalCode,
        country: userAddresses.country,
        location: ADDRESS_LOCATION_SQL,
        isDefault: userAddresses.isDefault,
        isValidated: userAddresses.isValidated,
        validatedAt: userAddresses.validatedAt,
        deliveryInstructions: userAddresses.deliveryInstructions,
        createdAt: userAddresses.createdAt,
        updatedAt: userAddresses.updatedAt,
        deletedAt: userAddresses.deletedAt,
      })
      .from(userAddresses)
      .where(eq(userAddresses.id, id))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : inflateAddress(row);
  }

  async listForUser(userId: string): Promise<readonly UserAddress[]> {
    const rows = await this.db
      .select({
        id: userAddresses.id,
        userId: userAddresses.userId,
        label: userAddresses.label,
        line1: userAddresses.line1,
        line2: userAddresses.line2,
        city: userAddresses.city,
        region: userAddresses.region,
        postalCode: userAddresses.postalCode,
        country: userAddresses.country,
        location: ADDRESS_LOCATION_SQL,
        isDefault: userAddresses.isDefault,
        isValidated: userAddresses.isValidated,
        validatedAt: userAddresses.validatedAt,
        deliveryInstructions: userAddresses.deliveryInstructions,
        createdAt: userAddresses.createdAt,
        updatedAt: userAddresses.updatedAt,
        deletedAt: userAddresses.deletedAt,
      })
      .from(userAddresses)
      .where(and(eq(userAddresses.userId, userId), isNull(userAddresses.deletedAt)))
      .orderBy(desc(userAddresses.isDefault), desc(userAddresses.createdAt));
    return rows.map((row) => inflateAddress(row));
  }

  async create(input: CreateUserAddressInput): Promise<UserAddress> {
    const id = input.id ?? newId();
    const [inserted] = await this.db
      .insert(userAddresses)
      .values({ ...input, id, location: pointToSql(input.location) })
      .returning({ id: userAddresses.id });
    if (inserted === undefined) throw new RepositoryError('user_addresses insert returned no row');
    const row = await this.findById(inserted.id);
    if (row === null)
      throw new RepositoryError(`user_addresses ${inserted.id} disappeared after insert`);
    return row;
  }

  /**
   * Partial update for the user-mutable address fields. Returns the inflated
   * row (location parsed back into a GeoPoint), or `null` if no row matches —
   * the caller decides whether that means 404 or cross-user RLS reject.
   * `setDefault` is the only path for flipping `is_default`.
   */
  async update(id: string, patch: UpdateUserAddressPatch): Promise<UserAddress | null> {
    const { location, ...rest } = patch;
    const payload = {
      ...rest,
      ...(location !== undefined ? { location: pointToSql(location) } : {}),
      updatedAt: new Date(),
    };
    const [updated] = await this.db
      .update(userAddresses)
      .set(payload)
      .where(and(eq(userAddresses.id, id), isNull(userAddresses.deletedAt)))
      .returning({ id: userAddresses.id });
    if (updated === undefined) return null;
    return this.findById(updated.id);
  }

  async setDefault(userId: string, addressId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(userAddresses)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(and(eq(userAddresses.userId, userId), eq(userAddresses.isDefault, true)));
      await tx
        .update(userAddresses)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(and(eq(userAddresses.id, addressId), eq(userAddresses.userId, userId)));
    });
  }

  async softDelete(id: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(userAddresses)
      .set({ deletedAt: now, updatedAt: now, isDefault: false })
      .where(and(eq(userAddresses.id, id), isNull(userAddresses.deletedAt)));
  }
}

export class UserIdDocumentsRepository extends BaseRepository {
  async create(
    input: Omit<NewUserIdDocument, 'id'> & { readonly id?: string },
  ): Promise<UserIdDocument> {
    const [row] = await this.db
      .insert(userIdDocuments)
      .values({ ...input, id: input.id ?? newId() })
      .returning();
    if (row === undefined) throw new RepositoryError('user_id_documents insert returned no row');
    return row;
  }

  async listForUser(userId: string): Promise<readonly UserIdDocument[]> {
    return this.db
      .select()
      .from(userIdDocuments)
      .where(eq(userIdDocuments.userId, userId))
      .orderBy(desc(userIdDocuments.createdAt));
  }

  async markVerified(id: string, verificationRef: string): Promise<UserIdDocument | null> {
    const [row] = await this.db
      .update(userIdDocuments)
      .set({
        verified: true,
        verifiedAt: new Date(),
        verificationRef,
        updatedAt: new Date(),
      })
      .where(eq(userIdDocuments.id, id))
      .returning();
    return row ?? null;
  }
}

export interface RotateSessionInput {
  readonly predecessorId: string;
  readonly successor: Omit<NewSession, 'id'> & { readonly id?: string };
}

export class SessionsRepository extends BaseRepository {
  async create(input: Omit<NewSession, 'id'> & { readonly id?: string }): Promise<Session> {
    const [row] = await this.db
      .insert(sessions)
      .values({ ...input, id: input.id ?? newId() })
      .returning();
    if (row === undefined) throw new RepositoryError('sessions insert returned no row');
    return row;
  }

  async findById(id: string): Promise<Session | null> {
    const [row] = await this.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * Returns any session matching the hash — including rotated or revoked
   * ones. The caller inspects `rotatedAt`/`revokedAt` to decide whether the
   * incoming refresh is fresh, a reuse attempt, or a stale revoked token.
   */
  async findByRefreshTokenHash(hash: Uint8Array): Promise<Session | null> {
    const [row] = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.refreshTokenHash, hash))
      .limit(1);
    return row ?? null;
  }

  /**
   * Atomically issues a successor session and stamps the predecessor with
   * `rotated_at` + `rotated_to`. The whole operation runs in a single
   * transaction so a refresh either fully succeeds or leaves the
   * predecessor still usable — we never end up with two simultaneously
   * valid refresh tokens in the same family.
   */
  async rotate(input: RotateSessionInput): Promise<Session> {
    return this.db.transaction(async (tx) => {
      const successorId = input.successor.id ?? newId();
      const [successor] = await tx
        .insert(sessions)
        .values({ ...input.successor, id: successorId })
        .returning();
      if (successor === undefined) throw new RepositoryError('sessions insert returned no row');
      const [predecessor] = await tx
        .update(sessions)
        .set({ rotatedAt: new Date(), rotatedTo: successorId })
        .where(and(eq(sessions.id, input.predecessorId), isNull(sessions.rotatedAt)))
        .returning({ id: sessions.id });
      if (predecessor === undefined) {
        throw new RepositoryError('predecessor session unavailable for rotation', {
          predecessorId: input.predecessorId,
        });
      }
      return successor;
    });
  }

  async touch(id: string, at: Date): Promise<void> {
    await this.db.update(sessions).set({ lastUsedAt: at }).where(eq(sessions.id, id));
  }

  async revoke(id: string): Promise<void> {
    await this.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, id));
  }

  /**
   * Revokes every non-revoked row in a refresh-token family. Called when a
   * reuse is detected: every chain descended from the original login is
   * burned so the attacker holding the stolen token cannot continue. The
   * legitimate user is forced to log in again.
   */
  async revokeFamily(familyId: string): Promise<number> {
    const result = await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.familyId, familyId), isNull(sessions.revokedAt)));
    return result.count;
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  }

  async deleteExpired(now: Date): Promise<number> {
    const result = await this.db.delete(sessions).where(lt(sessions.expiresAt, now));
    return result.count;
  }
}

export class PasswordResetTokensRepository extends BaseRepository {
  async create(
    input: Omit<NewPasswordResetToken, 'id'> & { readonly id?: string },
  ): Promise<PasswordResetToken> {
    const [row] = await this.db
      .insert(passwordResetTokens)
      .values({ ...input, id: input.id ?? newId() })
      .returning();
    if (row === undefined)
      throw new RepositoryError('password_reset_tokens insert returned no row');
    return row;
  }

  /**
   * Looks up a token by the SHA-256 of the presented code. Returns the row
   * regardless of `used_at` / `expires_at` — the service inspects those to
   * choose a precise error. The lookup is keyed by the secret hash, so
   * returning expired/used rows leaks nothing.
   */
  async findByCodeHash(codeHash: Uint8Array): Promise<PasswordResetToken | null> {
    const [row] = await this.db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.codeHash, codeHash))
      .limit(1);
    return row ?? null;
  }

  /**
   * Atomically consumes a token. The `used_at IS NULL` guard makes this the
   * single-use chokepoint: if two requests race on the same code, exactly one
   * UPDATE matches and the other gets `false`. Returns whether this call was
   * the one to consume it.
   */
  async markUsed(id: string, usedAt = new Date()): Promise<boolean> {
    const rows = await this.db
      .update(passwordResetTokens)
      .set({ usedAt })
      .where(and(eq(passwordResetTokens.id, id), isNull(passwordResetTokens.usedAt)))
      .returning({ id: passwordResetTokens.id });
    return rows.length > 0;
  }

  /**
   * Stamps `used_at` on every still-active token for a user. Called when a
   * fresh reset is requested so previously emailed codes are immediately
   * dead, and after a successful reset to sweep any siblings. Returns the
   * number of tokens invalidated.
   */
  async invalidateAllActiveForUser(userId: string, at = new Date()): Promise<number> {
    const result = await this.db
      .update(passwordResetTokens)
      .set({ usedAt: at })
      .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
    return result.count;
  }

  async deleteExpired(now: Date): Promise<number> {
    const result = await this.db
      .delete(passwordResetTokens)
      .where(lt(passwordResetTokens.expiresAt, now));
    return result.count;
  }
}
