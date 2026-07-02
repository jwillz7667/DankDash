/**
 * Vendor write-side service for dispensary-scoped promo codes.
 *
 *   list()        — GET /v1/vendor/promotions. Every promo the dispensary
 *                   owns (active + inactive), newest first, each with its live
 *                   redemption count for the "used / cap" column.
 *   create()      — POST /v1/vendor/promotions. Pins scope='dispensary' and
 *                   the caller's dispensaryId; the code's global uniqueness
 *                   (citext) is pre-flighted so a collision is a typed 409
 *                   rather than a raw constraint error.
 *   patch()       — PATCH /v1/vendor/promotions/:id. Toggles `active`. Cross-
 *                   dispensary ids match zero rows → 404.
 *   deactivate()  — DELETE /v1/vendor/promotions/:id. Flips active=false; 204.
 *
 * Authorization is manager+ (owner/manager per-dispensary staff role) — a
 * budtender can browse the store but not run its promotions. The coarse JWT
 * role gate is on the controller (@Roles); the authoritative per-dispensary
 * gate is `assertManagerPlus` here, mirroring how vendor pricing changes are
 * meant to narrow in the service (vendor-listings.service.ts).
 *
 * Every op runs inside a tx that sets `app.current_dispensary_id` so the RLS
 * policy on `promo_codes` (migration 0020) activates under the app_vendor
 * role; the application-layer `WHERE dispensary_id = ?` in the repo is the
 * primary guard in the current single-role deployment.
 */
import { sql, type Database } from '@dankdash/db';
import { ConflictError, ForbiddenError, NotFoundError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import { projectPromo } from '../promo.mapper.js';
import type { VendorContext } from '../../listings/vendor/vendor-context.types.js';
import type {
  CreatePromoRequest,
  PatchPromoRequest,
  PromoListResponse,
  PromoResponse,
} from '../dto/index.js';
import type { PromotionsScopedRepos, PromotionsScopedReposFactory } from '../promotions-repos.js';

@Injectable()
export class VendorPromotionsService {
  constructor(
    private readonly db: Database,
    private readonly reposFor: PromotionsScopedReposFactory,
  ) {}

  async list(ctx: VendorContext): Promise<PromoListResponse> {
    assertManagerPlus(ctx);
    const promotions = await this.withScope(ctx, async ({ promoCodes, promoRedemptions }) => {
      const rows = await promoCodes.listForDispensary(ctx.dispensaryId);
      const counts = await promoRedemptions.countsForPromos(rows.map((r) => r.id));
      return rows.map((row) => projectPromo(row, counts.get(row.id) ?? 0));
    });
    return { promotions };
  }

  async create(ctx: VendorContext, body: CreatePromoRequest): Promise<PromoResponse> {
    assertManagerPlus(ctx);
    return this.withScope(ctx, async ({ promoCodes }) => {
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
        scope: 'dispensary',
        dispensaryId: ctx.dispensaryId,
        minSubtotalCents: body.minSubtotalCents,
        maxDiscountCents: body.maxDiscountCents ?? null,
        startsAt: new Date(body.startsAt),
        endsAt: body.endsAt == null ? null : new Date(body.endsAt),
        maxRedemptions: body.maxRedemptions ?? null,
        maxRedemptionsPerUser: body.maxRedemptionsPerUser,
        active: true,
        createdBy: ctx.userId,
      });
      // A freshly created promo has no redemptions yet.
      return projectPromo(row, 0);
    });
  }

  async patch(ctx: VendorContext, id: string, body: PatchPromoRequest): Promise<PromoResponse> {
    assertManagerPlus(ctx);
    return this.withScope(ctx, async ({ promoCodes, promoRedemptions }) => {
      const updated = await promoCodes.updateForDispensary(id, ctx.dispensaryId, {
        active: body.active,
      });
      if (updated === null) throw new NotFoundError('Promotion', id);
      const count = await promoRedemptions.countForPromo(updated.id);
      return projectPromo(updated, count);
    });
  }

  async deactivate(ctx: VendorContext, id: string): Promise<void> {
    assertManagerPlus(ctx);
    const updated = await this.withScope(ctx, ({ promoCodes }) =>
      promoCodes.updateForDispensary(id, ctx.dispensaryId, { active: false }),
    );
    if (updated === null) throw new NotFoundError('Promotion', id);
  }

  private withScope<T>(
    ctx: VendorContext,
    fn: (deps: PromotionsScopedRepos) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.current_dispensary_id', ${ctx.dispensaryId}, true)`,
      );
      return fn(this.reposFor(tx));
    });
  }
}

/**
 * Promotions are a manager+ surface. `staffRole` is the caller's role at THIS
 * dispensary (from the VendorContextGuard), which is the authoritative gate;
 * a budtender is rejected here even though the coarse JWT-role gate on the
 * controller lets staff through.
 */
function assertManagerPlus(ctx: VendorContext): void {
  if (ctx.staffRole !== 'manager' && ctx.staffRole !== 'owner') {
    throw new ForbiddenError('Promotions require a manager or owner role', {
      dispensaryId: ctx.dispensaryId,
      staffRole: ctx.staffRole,
    });
  }
}
