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

export class CartsRepository extends BaseRepository {
  async findById(id: string): Promise<Cart | null> {
    const [row] = await this.db.select().from(carts).where(eq(carts.id, id)).limit(1);
    return row ?? null;
  }

  async findActiveForUserAndDispensary(userId: string, dispensaryId: string): Promise<Cart | null> {
    const [row] = await this.db
      .select()
      .from(carts)
      .where(and(eq(carts.userId, userId), eq(carts.dispensaryId, dispensaryId)))
      .limit(1);
    return row ?? null;
  }

  async createOrGetActive(userId: string, dispensaryId: string): Promise<Cart> {
    const existing = await this.findActiveForUserAndDispensary(userId, dispensaryId);
    if (existing !== null) return existing;
    const [row] = await this.db
      .insert(carts)
      .values({ id: newId(), userId, dispensaryId } satisfies NewCart)
      .returning();
    if (row === undefined) throw new RepositoryError('carts insert returned no row');
    return row;
  }

  async touch(id: string): Promise<void> {
    await this.db
      .update(carts)
      .set({
        updatedAt: new Date(),
        expiresAt: sql`(NOW() + interval '4 hours')`,
      })
      .where(eq(carts.id, id));
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
