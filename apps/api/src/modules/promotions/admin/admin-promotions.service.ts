/**
 * Admin write-side service for platform-scoped promo codes — global coupons
 * funded by the platform (dispensary_id NULL). Same lifecycle as the vendor
 * surface, minus the tenant scoping: admins operate on the primary DB role
 * (no `app.current_dispensary_id`, no RLS), so reads/writes are filtered to
 * `scope = 'platform'` in the repo rather than by a dispensary GUC.
 *
 * Authorization is the controller's @Roles('admin','superadmin') gate; there
 * is no per-tenant role to narrow further.
 */
import { type Database } from '@dankdash/db';
import { ConflictError, NotFoundError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import { projectPromo } from '../promo.mapper.js';
import type {
  CreatePromoRequest,
  PatchPromoRequest,
  PromoListResponse,
  PromoResponse,
} from '../dto/index.js';
import type { PromotionsScopedReposFactory } from '../promotions-repos.js';

@Injectable()
export class AdminPromotionsService {
  constructor(
    private readonly db: Database,
    private readonly reposFor: PromotionsScopedReposFactory,
  ) {}

  async list(): Promise<PromoListResponse> {
    const { promoCodes, promoRedemptions } = this.reposFor(this.db);
    const rows = await promoCodes.listPlatform();
    const counts = await promoRedemptions.countsForPromos(rows.map((r) => r.id));
    return { promotions: rows.map((row) => projectPromo(row, counts.get(row.id) ?? 0)) };
  }

  async create(createdBy: string, body: CreatePromoRequest): Promise<PromoResponse> {
    return this.db.transaction(async (tx) => {
      const { promoCodes } = this.reposFor(tx);
      const existing = await promoCodes.findByCode(body.code);
      if (existing !== null) {
        throw new ConflictError('PROMO_CODE_TAKEN', 'A promo with this code already exists', {
          code: body.code,
        });
      }
      const row = await promoCodes.create({
        code: body.code,
        type: body.type,
        value: body.value,
        scope: 'platform',
        dispensaryId: null,
        minSubtotalCents: body.minSubtotalCents,
        maxDiscountCents: body.maxDiscountCents ?? null,
        startsAt: new Date(body.startsAt),
        endsAt: body.endsAt == null ? null : new Date(body.endsAt),
        maxRedemptions: body.maxRedemptions ?? null,
        maxRedemptionsPerUser: body.maxRedemptionsPerUser,
        active: true,
        createdBy,
      });
      return projectPromo(row, 0);
    });
  }

  async patch(id: string, body: PatchPromoRequest): Promise<PromoResponse> {
    return this.db.transaction(async (tx) => {
      const { promoCodes, promoRedemptions } = this.reposFor(tx);
      const updated = await promoCodes.updatePlatform(id, { active: body.active });
      if (updated === null) throw new NotFoundError('Promotion', id);
      const count = await promoRedemptions.countForPromo(updated.id);
      return projectPromo(updated, count);
    });
  }

  async deactivate(id: string): Promise<void> {
    const { promoCodes } = this.reposFor(this.db);
    const updated = await promoCodes.updatePlatform(id, { active: false });
    if (updated === null) throw new NotFoundError('Promotion', id);
  }
}
