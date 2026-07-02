/**
 * Patch-promo request body. Only `active` is mutable through the API —
 * identity and economics (code, type, value, scope, window, caps) are frozen
 * once a coupon exists so a live code's meaning can never change under people
 * who have already seen or redeemed it. Toggling `active` is the supported
 * lifecycle operation (deactivate / reactivate).
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const PatchPromoRequestSchema = z
  .object({
    active: z.boolean(),
  })
  .strict();

export type PatchPromoRequest = z.infer<typeof PatchPromoRequestSchema>;

export class PatchPromoRequestDto extends createZodDto(PatchPromoRequestSchema) {}
