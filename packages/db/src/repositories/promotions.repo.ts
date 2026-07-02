import { RepositoryError } from '@dankdash/types';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import {
  promoCodes,
  promoRedemptions,
  type NewPromoCode,
  type NewPromoRedemption,
  type PromoCode,
  type PromoRedemption,
} from '../schema/promotions.js';
import { BaseRepository, newId } from './base.js';

/** Columns a caller may patch on an existing promo. Immutable identity/scope
 *  fields (code, type, value, scope, dispensary_id) are intentionally excluded
 *  — changing them would rewrite a live coupon's meaning under redeemers. */
export type PromoCodePatch = Partial<
  Pick<
    NewPromoCode,
    | 'minSubtotalCents'
    | 'maxDiscountCents'
    | 'startsAt'
    | 'endsAt'
    | 'maxRedemptions'
    | 'maxRedemptionsPerUser'
    | 'active'
  >
>;

export class PromoCodesRepository extends BaseRepository {
  async findById(id: string): Promise<PromoCode | null> {
    const [row] = await this.db.select().from(promoCodes).where(eq(promoCodes.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * Case-insensitive lookup by code (the column is `citext`). Used by the
   * cart apply endpoint and by checkout. Returns null on miss so the service
   * surfaces a typed `PROMO_NOT_FOUND` rather than leaking a DB shape.
   */
  async findByCode(code: string): Promise<PromoCode | null> {
    const [row] = await this.db.select().from(promoCodes).where(eq(promoCodes.code, code)).limit(1);
    return row ?? null;
  }

  /**
   * SELECT ... FOR UPDATE by id. Checkout locks the promo row before counting
   * redemptions so the global `max_redemptions` cap is enforced without a
   * race between two concurrent checkouts of the same limited code. MUST run
   * inside a transaction.
   */
  async findByIdForUpdate(id: string): Promise<PromoCode | null> {
    const [row] = await this.db
      .select()
      .from(promoCodes)
      .where(eq(promoCodes.id, id))
      .for('update')
      .limit(1);
    return row ?? null;
  }

  async create(input: Omit<NewPromoCode, 'id'> & { readonly id?: string }): Promise<PromoCode> {
    const [row] = await this.db
      .insert(promoCodes)
      .values({ ...input, id: input.id ?? newId() })
      .returning();
    if (row === undefined) throw new RepositoryError('promo_codes insert returned no row');
    return row;
  }

  /** All promos owned by a dispensary (active + inactive), newest first. */
  async listForDispensary(dispensaryId: string): Promise<readonly PromoCode[]> {
    return this.db
      .select()
      .from(promoCodes)
      .where(eq(promoCodes.dispensaryId, dispensaryId))
      .orderBy(sql`${promoCodes.createdAt} DESC`);
  }

  /** All platform-scoped promos (admin surface), newest first. */
  async listPlatform(): Promise<readonly PromoCode[]> {
    return this.db
      .select()
      .from(promoCodes)
      .where(eq(promoCodes.scope, 'platform'))
      .orderBy(sql`${promoCodes.createdAt} DESC`);
  }

  async findByIdForDispensary(id: string, dispensaryId: string): Promise<PromoCode | null> {
    const [row] = await this.db
      .select()
      .from(promoCodes)
      .where(and(eq(promoCodes.id, id), eq(promoCodes.dispensaryId, dispensaryId)))
      .limit(1);
    return row ?? null;
  }

  async findPlatformById(id: string): Promise<PromoCode | null> {
    const [row] = await this.db
      .select()
      .from(promoCodes)
      .where(and(eq(promoCodes.id, id), eq(promoCodes.scope, 'platform')))
      .limit(1);
    return row ?? null;
  }

  /** Tenant-scoped patch — a cross-dispensary id matches zero rows → null. */
  async updateForDispensary(
    id: string,
    dispensaryId: string,
    patch: PromoCodePatch,
  ): Promise<PromoCode | null> {
    const [row] = await this.db
      .update(promoCodes)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(promoCodes.id, id), eq(promoCodes.dispensaryId, dispensaryId)))
      .returning();
    return row ?? null;
  }

  /** Admin patch scoped to platform promos — a dispensary promo id → null. */
  async updatePlatform(id: string, patch: PromoCodePatch): Promise<PromoCode | null> {
    const [row] = await this.db
      .update(promoCodes)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(promoCodes.id, id), eq(promoCodes.scope, 'platform')))
      .returning();
    return row ?? null;
  }
}

export class PromoRedemptionsRepository extends BaseRepository {
  async create(
    input: Omit<NewPromoRedemption, 'id'> & { readonly id?: string },
  ): Promise<PromoRedemption> {
    const [row] = await this.db
      .insert(promoRedemptions)
      .values({ ...input, id: input.id ?? newId() })
      .returning();
    if (row === undefined) throw new RepositoryError('promo_redemptions insert returned no row');
    return row;
  }

  /** Total redemptions of a promo across all users. */
  async countForPromo(promoId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(promoRedemptions)
      .where(eq(promoRedemptions.promoId, promoId));
    return row?.n ?? 0;
  }

  /** Redemptions of a promo by one user (per-user cap enforcement). */
  async countForPromoAndUser(promoId: string, userId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(promoRedemptions)
      .where(and(eq(promoRedemptions.promoId, promoId), eq(promoRedemptions.userId, userId)));
    return row?.n ?? 0;
  }

  /**
   * Redemption counts for a set of promos in one grouped round trip — the
   * portal list view renders "used / cap" per row without N+1. Promos with
   * zero redemptions are absent from the result; the caller defaults them to 0.
   */
  async countsForPromos(promoIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    if (promoIds.length === 0) return new Map();
    const rows = await this.db
      .select({ promoId: promoRedemptions.promoId, n: count() })
      .from(promoRedemptions)
      .where(inArray(promoRedemptions.promoId, [...promoIds]))
      .groupBy(promoRedemptions.promoId);
    return new Map(rows.map((r) => [r.promoId, r.n]));
  }
}
