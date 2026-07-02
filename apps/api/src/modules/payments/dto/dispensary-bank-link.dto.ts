/**
 * Request/response shapes for the vendor-side Aeropay bank-account linking
 * surface used for dispensary payouts.
 *
 *   POST /v1/vendor/payouts/bank-account/link
 *     body  → { returnUrl }
 *     201   → { link: { id, hostedUrl, expiresAt } }
 *
 *   GET  /v1/vendor/payouts/bank-account
 *     200   → { linked }
 *
 * The portal opens `link.hostedUrl` (Aeropay hosted flow); on completion
 * Aeropay redirects back to `returnUrl` and fires a `bank_account.linked`
 * webhook that persists the confirmed bank-account id onto the dispensary's
 * `aeropay_account_ref` (see DispensaryBankLinkService.applyBankLinked).
 *
 * The status endpoint deliberately exposes only a boolean — the underlying
 * `aeropay_account_ref` is a Restricted bank reference (spec §8.1) and must
 * not travel to the browser, mirroring how vendor settings surfaces
 * `hasAeropayAccount` rather than the ref itself.
 *
 * `returnUrl` is required and must be an absolute URL so a misconfigured
 * portal cannot ship a relative path into Aeropay's redirect handling —
 * same validation the consumer link DTO applies.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const StartDispensaryBankLinkRequestSchema = z
  .object({
    returnUrl: z.string().url(),
  })
  .strict();

export type StartDispensaryBankLinkRequest = z.infer<typeof StartDispensaryBankLinkRequestSchema>;

export class StartDispensaryBankLinkRequestDto extends createZodDto(
  StartDispensaryBankLinkRequestSchema,
) {}

export const DispensaryBankLinkSessionSchema = z
  .object({
    id: z.string().min(1),
    hostedUrl: z.string().url(),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type DispensaryBankLinkSession = z.infer<typeof DispensaryBankLinkSessionSchema>;

export const StartDispensaryBankLinkResponseSchema = z
  .object({
    link: DispensaryBankLinkSessionSchema,
  })
  .strict();

export type StartDispensaryBankLinkResponse = z.infer<typeof StartDispensaryBankLinkResponseSchema>;

export const DispensaryBankAccountStatusResponseSchema = z
  .object({
    linked: z.boolean(),
  })
  .strict();

export type DispensaryBankAccountStatusResponse = z.infer<
  typeof DispensaryBankAccountStatusResponseSchema
>;
