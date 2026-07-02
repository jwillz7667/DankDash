/**
 * Promo response projection — shared by the vendor and admin surfaces.
 *
 *   GET/POST/PATCH /v1/vendor/promotions[...]  — dispensary-scoped
 *   GET/POST/PATCH /v1/admin/promotions[...]   — platform-scoped
 *
 * Money fields are integer cents. `redemptionCount` is the live count of
 * `promo_redemptions` for this code (used vs the `maxRedemptions` cap).
 */
import { z } from 'zod';

export const PromoResponseSchema = z
  .object({
    id: z.string().uuid(),
    code: z.string(),
    type: z.enum(['percent', 'fixed_amount', 'free_delivery']),
    value: z.number().int(),
    scope: z.enum(['platform', 'dispensary']),
    dispensaryId: z.string().uuid().nullable(),
    minSubtotalCents: z.number().int().nonnegative(),
    maxDiscountCents: z.number().int().positive().nullable(),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }).nullable(),
    maxRedemptions: z.number().int().positive().nullable(),
    maxRedemptionsPerUser: z.number().int().positive(),
    active: z.boolean(),
    redemptionCount: z.number().int().nonnegative(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type PromoResponse = z.infer<typeof PromoResponseSchema>;

export const PromoListResponseSchema = z
  .object({
    promotions: z.array(PromoResponseSchema).readonly(),
  })
  .strict();

export type PromoListResponse = z.infer<typeof PromoListResponseSchema>;
