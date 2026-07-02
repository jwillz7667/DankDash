/**
 * Create-promo request body — shared by vendor and admin. `scope` and
 * `dispensaryId` are NOT in the body: the service pins them from context
 * (vendor → 'dispensary' + the caller's dispensary; admin → 'platform' + null)
 * so a caller can never mint a code for a scope it does not own.
 *
 * Cross-field rules mirror the DB CHECK constraints so a bad request fails at
 * the boundary with a precise message rather than as a Postgres constraint
 * violation:
 *   - percent:       value in [1, 100]
 *   - fixed_amount:  value > 0 (cents)
 *   - free_delivery: value = 0
 *   - maxDiscountCents may only be set for a percent code (it caps the % cut)
 *   - endsAt, when present, must be after startsAt
 *
 * `code` is trimmed, restricted to [A-Za-z0-9-], and uppercased — the column
 * is citext so the stored form is canonical and lookups are case-insensitive.
 */
import { PROMO_CODE_MAX_LENGTH, PROMO_CODE_MIN_LENGTH } from '@dankdash/promotions';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const codeSchema = z
  .string()
  .trim()
  .min(PROMO_CODE_MIN_LENGTH)
  .max(PROMO_CODE_MAX_LENGTH)
  .regex(/^[A-Za-z0-9-]+$/, 'code must contain only letters, numbers, and dashes')
  .transform((value) => value.toUpperCase());

export const CreatePromoRequestSchema = z
  .object({
    code: codeSchema,
    type: z.enum(['percent', 'fixed_amount', 'free_delivery']),
    value: z.number().int(),
    minSubtotalCents: z.number().int().nonnegative().default(0),
    maxDiscountCents: z.number().int().positive().nullable().optional(),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }).nullable().optional(),
    maxRedemptions: z.number().int().positive().nullable().optional(),
    maxRedemptionsPerUser: z.number().int().positive().default(1),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.type === 'percent' && (data.value < 1 || data.value > 100)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'percent value must be between 1 and 100',
      });
    }
    if (data.type === 'fixed_amount' && data.value <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'fixed_amount value must be a positive number of cents',
      });
    }
    if (data.type === 'free_delivery' && data.value !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'free_delivery value must be 0',
      });
    }
    if (data.maxDiscountCents != null && data.type !== 'percent') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxDiscountCents'],
        message: 'maxDiscountCents may only be set for a percent promo',
      });
    }
    if (
      data.endsAt != null &&
      new Date(data.endsAt).getTime() <= new Date(data.startsAt).getTime()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsAt'],
        message: 'endsAt must be after startsAt',
      });
    }
  });

export type CreatePromoRequest = z.infer<typeof CreatePromoRequestSchema>;

export class CreatePromoRequestDto extends createZodDto(CreatePromoRequestSchema) {}
