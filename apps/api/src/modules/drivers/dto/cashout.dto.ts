/**
 * POST /v1/driver/cashout request + response schemas.
 *
 * Phase 20 ships the persistence + balance gate; the real Aeropay
 * payout call is flag-gated behind `AEROPAY_LIVE` (default false) and
 * stubbed until the driver-side KYC + bank-account-link flow lands.
 * The persisted `payouts` row lets ops process the request manually
 * while live integration is pending — see `DriverCashoutService` for
 * the orchestration.
 *
 * Wire shape mirrors the iOS `CashoutResponseDTO` exactly: integer
 * cents for the amount, ISO-8601 with offset for `requestedAt`, the
 * canonical `payouts.status` enum string (we expose just the
 * `'pending' | 'processing' | 'completed' | 'failed' | 'canceled'`
 * subset that's relevant to a cashout — the driver app surfaces
 * 'pending' as "Pending" in the wallet history).
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Subset of `payoutStatus` enum that we currently emit for a fresh
 * cashout request. `'processing'` lights up once the Aeropay live
 * client kicks off the bank push; that's deferred but the contract
 * already accommodates it so the iOS schema doesn't have to change.
 */
export const CashoutStatusSchema = z.enum([
  'pending',
  'processing',
  'completed',
  'failed',
  'canceled',
]);
export type CashoutStatus = z.infer<typeof CashoutStatusSchema>;

export const DriverCashoutRequestSchema = z
  .object({
    /**
     * Integer cents. We reject `0` because zero-amount cashouts are
     * never legitimate — the iOS layer should disable the CTA in that
     * state — and unbounded upper is fine here because the
     * balance-gate inside the service rejects anything > available.
     */
    amountCents: z.number().int().positive(),
  })
  .strict();

export type DriverCashoutRequest = z.infer<typeof DriverCashoutRequestSchema>;

export class DriverCashoutRequestDto extends createZodDto(DriverCashoutRequestSchema) {}

export const DriverCashoutResponseSchema = z
  .object({
    id: z.string().uuid(),
    amountCents: z.number().int().positive(),
    status: CashoutStatusSchema,
    requestedAt: z.string().datetime({ offset: true }),
    /**
     * Upstream Aeropay payout id when the live client lit up; `null`
     * for stubbed and persisted-only requests. Drivers don't display
     * this — it's wire-only so ops dashboards can correlate against
     * Aeropay's portal.
     */
    aeropayPayoutRef: z.string().nullable(),
  })
  .strict();

export type DriverCashoutResponse = z.infer<typeof DriverCashoutResponseSchema>;
