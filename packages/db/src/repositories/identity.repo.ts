import { RepositoryError } from '@dankdash/types';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { type GeoPoint } from '../schema/custom-types.js';
import { parsePoint, pointToSql } from '../schema/geo.js';
import {
  sessions,
  type NewSession,
  type NewUser,
  type NewUserAddress,
  type NewUserIdDocument,
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
