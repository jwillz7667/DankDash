/**
 * Apply-promo request body.
 *
 *   POST /v1/carts/:id/promo             — { code }
 *
 * Just the human-entered code. The principal (cart owner) comes from the
 * JWT and the cart from the path. The service normalizes the code
 * (trim + uppercase) before the case-insensitive lookup, so leading spaces
 * or lowercase input still resolve. Length bounds match the promo-code
 * shape enforced on creation (`@dankdash/promotions` PROMO_CODE_MIN/MAX).
 */
import { PROMO_CODE_MAX_LENGTH, PROMO_CODE_MIN_LENGTH } from '@dankdash/promotions';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ApplyPromoRequestSchema = z
  .object({
    code: z.string().trim().min(PROMO_CODE_MIN_LENGTH).max(PROMO_CODE_MAX_LENGTH),
  })
  .strict();

export type ApplyPromoRequest = z.infer<typeof ApplyPromoRequestSchema>;

export class ApplyPromoRequestDto extends createZodDto(ApplyPromoRequestSchema) {}
