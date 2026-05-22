/**
 * DTOs for the driver-self dispatch-offer surface (Phase 8.4):
 *
 *   POST /v1/driver/offers/:id/accept
 *   POST /v1/driver/offers/:id/decline   { reason? }
 *
 * The accept body is empty (the driver identifies via JWT + the offer
 * id is the URL param). The decline body carries an optional human
 * `reason` written to `dispatch_offers.decline_reason` — used by ops
 * to surface "why are drivers passing on these offers" without going
 * back to the driver one-by-one. Trimmed and capped at 280 chars so a
 * pasted essay can't bloat the offer table; null is the default at the
 * DB tier.
 *
 * `DispatchOfferResponseSchema` mirrors `dispatch_offers` 1:1 with the
 * timestamp columns serialised to ISO-8601 strings and the NUMERIC
 * `distance_miles` left as a string (the same shape NUMERIC takes
 * elsewhere in the API).
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const DeclineOfferRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(280).optional(),
  })
  .strict();
export type DeclineOfferRequest = z.infer<typeof DeclineOfferRequestSchema>;
export class DeclineOfferRequestDto extends createZodDto(DeclineOfferRequestSchema) {}

export const DispatchOfferStatusSchema = z.enum(['offered', 'accepted', 'declined', 'expired']);
export type DispatchOfferResponseStatus = z.infer<typeof DispatchOfferStatusSchema>;

export const DispatchOfferResponseSchema = z
  .object({
    id: z.string().uuid(),
    orderId: z.string().uuid(),
    driverId: z.string().uuid(),
    offeredAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    payoutEstimateCents: z.number().int().min(0),
    distanceMiles: z.string(),
    status: DispatchOfferStatusSchema,
    respondedAt: z.string().datetime({ offset: true }).nullable(),
    declineReason: z.string().nullable(),
  })
  .strict();
export type DispatchOfferResponse = z.infer<typeof DispatchOfferResponseSchema>;
export class DispatchOfferResponseDto extends createZodDto(DispatchOfferResponseSchema) {}
