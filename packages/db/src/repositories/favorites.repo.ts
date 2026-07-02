import { and, desc, eq, sql } from 'drizzle-orm';
import { userFavorites, type UserFavorite } from '../schema/favorites.js';
import { BaseRepository, newId } from './base.js';

export interface FavoritesPageInput {
  readonly limit: number;
  readonly offset: number;
}

export interface FavoritesPage {
  readonly rows: readonly UserFavorite[];
  readonly total: number;
}

/**
 * Consumer favorites store. Writes are idempotent per (user, target) — the
 * partial unique indexes back an `ON CONFLICT DO NOTHING` upsert, so a
 * double-tap on the heart never errors and never duplicates. The service layer
 * gates existence/active-status of the target before calling `add*`, so the FK
 * violation path is unreachable in practice; the FK remains as defense in
 * depth. Removes return whether a row was actually deleted so the caller can
 * stay idempotent (DELETE of an un-saved target is a no-op, not a 404).
 */
export class FavoritesRepository extends BaseRepository {
  async addDispensary(userId: string, dispensaryId: string): Promise<boolean> {
    const inserted = await this.db
      .insert(userFavorites)
      .values({ id: newId(), userId, favoritableType: 'dispensary', dispensaryId })
      .onConflictDoNothing()
      .returning({ id: userFavorites.id });
    return inserted.length > 0;
  }

  async removeDispensary(userId: string, dispensaryId: string): Promise<boolean> {
    const deleted = await this.db
      .delete(userFavorites)
      .where(and(eq(userFavorites.userId, userId), eq(userFavorites.dispensaryId, dispensaryId)))
      .returning({ id: userFavorites.id });
    return deleted.length > 0;
  }

  async addProduct(userId: string, productId: string): Promise<boolean> {
    const inserted = await this.db
      .insert(userFavorites)
      .values({ id: newId(), userId, favoritableType: 'product', productId })
      .onConflictDoNothing()
      .returning({ id: userFavorites.id });
    return inserted.length > 0;
  }

  async removeProduct(userId: string, productId: string): Promise<boolean> {
    const deleted = await this.db
      .delete(userFavorites)
      .where(and(eq(userFavorites.userId, userId), eq(userFavorites.productId, productId)))
      .returning({ id: userFavorites.id });
    return deleted.length > 0;
  }

  /**
   * One page of the user's favorites, newest-saved first with `id` as a stable
   * tiebreaker (matches `user_favorites_user_feed_idx`), plus the total count so
   * the caller can build a page envelope. Hydration of the referenced
   * dispensaries / products is the service's job — done through the respective
   * repositories, never a cross-domain join.
   */
  async listForUser(userId: string, input: FavoritesPageInput): Promise<FavoritesPage> {
    const [rows, countRows] = await Promise.all([
      this.db
        .select()
        .from(userFavorites)
        .where(eq(userFavorites.userId, userId))
        .orderBy(desc(userFavorites.createdAt), desc(userFavorites.id))
        .limit(input.limit)
        .offset(input.offset),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(userFavorites)
        .where(eq(userFavorites.userId, userId)),
    ]);
    return { rows, total: countRows[0]?.count ?? 0 };
  }

  /** Purges every favorite a user owns — the favorites arm of account deletion. */
  async deleteAllForUser(userId: string): Promise<number> {
    const deleted = await this.db
      .delete(userFavorites)
      .where(eq(userFavorites.userId, userId))
      .returning({ id: userFavorites.id });
    return deleted.length;
  }
}
