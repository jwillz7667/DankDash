import { RepositoryError } from '@dankdash/types';
import { and, eq, lt, sql } from 'drizzle-orm';
import {
  cartItems,
  carts,
  type Cart,
  type CartItem,
  type NewCart,
  type NewCartItem,
} from '../schema/cart.js';
import { BaseRepository, newId } from './base.js';

/**
 * Cart time-to-live since last activity. Matches the spec's "carts expire
 * after 4 hours" and the `expires_at` column's `NOW() + interval '4 hours'`
 * default — the JS constant exists because `touch` recomputes the value
 * client-side to avoid a second round trip for the new expiry. Kept here
 * (not in `@dankdash/utils`) because the constant only has meaning paired
 * with the cart row's `expires_at` column.
 */
export const CART_TTL_MS = 4 * 60 * 60 * 1000;

export class CartsRepository extends BaseRepository {
  async findById(id: string): Promise<Cart | null> {
    const [row] = await this.db.select().from(carts).where(eq(carts.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * Cross-user-safe read. The cart service uses this for every read path so
   * a request from user A addressing user B's cart id returns null (→ 404
   * at the service) rather than 403. A 403 would leak whether the id
   * corresponds to a real cart owned by someone else.
   */
  async findByIdForUser(id: string, userId: string): Promise<Cart | null> {
    const [row] = await this.db
      .select()
      .from(carts)
      .where(and(eq(carts.id, id), eq(carts.userId, userId)))
      .limit(1);
    return row ?? null;
  }

  /**
   * SELECT ... FOR UPDATE on the cart row. Called first inside the
   * checkout transaction so a concurrent checkout of the same cart blocks
   * until the in-flight one commits or aborts. The serialization point
   * pairs with the listings FOR UPDATE that follows to keep the whole
   * inventory + order insert atomic.
   *
   * MUST be called inside a transaction — Postgres rejects FOR UPDATE on
   * an autocommitted statement. Caller is responsible for the tx context.
   */
  async findByIdForUserForUpdate(id: string, userId: string): Promise<Cart | null> {
    const [row] = await this.db
      .select()
      .from(carts)
      .where(and(eq(carts.id, id), eq(carts.userId, userId)))
      .for('update')
      .limit(1);
    return row ?? null;
  }

  async deleteById(id: string): Promise<void> {
    // cart_items has ON DELETE CASCADE so this single DELETE clears both.
    await this.db.delete(carts).where(eq(carts.id, id));
  }

  /**
   * User-scoped delete. Used by `DELETE /v1/carts/:id`. The WHERE pairs the
   * id with the principal's userId so a cross-user delete matches zero rows
   * — the response is the same 204 either way, which is correct: the
   * caller's cart (their owned id or nothing) is gone. Cascading FK on
   * `cart_items.cart_id` clears items in the same statement.
   */
  async deleteByIdForUser(id: string, userId: string): Promise<boolean> {
    const result = await this.db
      .delete(carts)
      .where(and(eq(carts.id, id), eq(carts.userId, userId)));
    return result.count > 0;
  }

  async findActiveForUserAndDispensary(userId: string, dispensaryId: string): Promise<Cart | null> {
    const [row] = await this.db
      .select()
      .from(carts)
      .where(and(eq(carts.userId, userId), eq(carts.dispensaryId, dispensaryId)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Atomic get-or-create. The pre-read short-circuits the common path
   * (existing cart, one query). The fallback INSERT uses
   * `ON CONFLICT (user_id, dispensary_id) DO NOTHING RETURNING *` so a
   * concurrent caller racing past the pre-read does not blow up the
   * second writer with a unique-constraint violation — instead the
   * returning clause is empty and we re-read the row the winner
   * inserted. Without this, a customer rapid-tapping "open cart" could
   * see a 500 surface on a perfectly benign UI double-call.
   */
  async createOrGetActive(userId: string, dispensaryId: string): Promise<Cart> {
    const existing = await this.findActiveForUserAndDispensary(userId, dispensaryId);
    if (existing !== null) return existing;
    const [inserted] = await this.db
      .insert(carts)
      .values({ id: newId(), userId, dispensaryId } satisfies NewCart)
      .onConflictDoNothing({ target: [carts.userId, carts.dispensaryId] })
      .returning();
    if (inserted !== undefined) return inserted;
    // Lost the race — the winner's row is now visible. Re-read by the
    // same predicate. If we still get null something has corrupted the
    // unique-constraint invariant; the typed RepositoryError surfaces
    // that as a 500 rather than a silent retry loop.
    const reread = await this.findActiveForUserAndDispensary(userId, dispensaryId);
    if (reread === null) {
      throw new RepositoryError(
        'carts.createOrGetActive: insert conflict but no row visible on re-read',
      );
    }
    return reread;
  }

  /**
   * Resets the 4-hour TTL clock and returns the refreshed row. The new
   * `expiresAt` is computed in JS (not via `NOW() + interval`) so the
   * caller can project it without a second round trip — DB clock vs app
   * clock drift on the order of seconds is irrelevant for a 4-hour TTL.
   * Returns `null` when the id no longer exists (a concurrent delete
   * raced past this update), which the service surfaces as 404 to keep
   * the response consistent with a missing-cart read.
   */
  async touch(id: string): Promise<Cart | null> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CART_TTL_MS);
    const [row] = await this.db
      .update(carts)
      .set({ updatedAt: now, expiresAt })
      .where(eq(carts.id, id))
      .returning();
    return row ?? null;
  }

  async deleteExpired(now: Date): Promise<number> {
    const result = await this.db.delete(carts).where(lt(carts.expiresAt, now));
    return result.count;
  }
}

export class CartItemsRepository extends BaseRepository {
  async listForCart(cartId: string): Promise<readonly CartItem[]> {
    return this.db.select().from(cartItems).where(eq(cartItems.cartId, cartId));
  }

  /**
   * Upsert by (cart_id, listing_id) — increments quantity rather than
   * stacking duplicate rows, which matches the spec's cart semantics.
   */
  async addOrIncrement(
    input: Omit<NewCartItem, 'id'> & { readonly id?: string },
  ): Promise<CartItem> {
    const [row] = await this.db
      .insert(cartItems)
      .values({ ...input, id: input.id ?? newId() })
      .onConflictDoUpdate({
        target: [cartItems.cartId, cartItems.listingId],
        set: {
          quantity: sql`${cartItems.quantity} + ${input.quantity}`,
          unitPriceCents: input.unitPriceCents,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (row === undefined) throw new RepositoryError('cart_items upsert returned no row');
    return row;
  }

  async setQuantity(id: string, quantity: number): Promise<CartItem | null> {
    if (quantity <= 0) {
      await this.db.delete(cartItems).where(eq(cartItems.id, id));
      return null;
    }
    const [row] = await this.db
      .update(cartItems)
      .set({ quantity, updatedAt: new Date() })
      .where(eq(cartItems.id, id))
      .returning();
    return row ?? null;
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(cartItems).where(eq(cartItems.id, id));
  }

  async clearCart(cartId: string): Promise<void> {
    await this.db.delete(cartItems).where(eq(cartItems.cartId, cartId));
  }
}
