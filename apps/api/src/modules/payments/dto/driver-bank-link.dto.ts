/**
 * Request/response shapes for the driver-side Aeropay bank-account linking
 * surface used for driver payouts (instant cashout + the nightly batch job).
 * The driver-side analogue of `dispensary-bank-link.dto.ts`.
 *
 *   POST /v1/driver/payouts/bank-account/link
 *     body  → { returnUrl }
 *     201   → { link: { id, hostedUrl, expiresAt } }
 *
 *   GET  /v1/driver/payouts/bank-account
 *     200   → { linked }
 *
 * The DankDasher app opens `link.hostedUrl` (Aeropay hosted flow) in a Safari
 * sheet; on completion Aeropay redirects back to `returnUrl` and fires a
 * `bank_account.linked` webhook that persists the confirmed bank-account id
 * onto the driver's `aeropay_account_ref` (see
 * DriverBankLinkService.applyBankLinked).
 *
 * The status endpoint deliberately exposes only a boolean — the underlying
 * `aeropay_account_ref` is a Restricted bank reference (spec §8.1) and must
 * not leave the API, mirroring the dispensary status surface.
 *
 * `returnUrl` is required and must be an absolute URL so a misconfigured
 * client cannot ship a relative path into Aeropay's redirect handling — same
 * validation the consumer + dispensary link DTOs apply.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const StartDriverBankLinkRequestSchema = z
  .object({
    returnUrl: z.string().url(),
  })
  .strict();

export type StartDriverBankLinkRequest = z.infer<typeof StartDriverBankLinkRequestSchema>;

export class StartDriverBankLinkRequestDto extends createZodDto(StartDriverBankLinkRequestSchema) {}

export const DriverBankLinkSessionSchema = z
  .object({
    id: z.string().min(1),
    hostedUrl: z.string().url(),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type DriverBankLinkSession = z.infer<typeof DriverBankLinkSessionSchema>;

export const StartDriverBankLinkResponseSchema = z
  .object({
    link: DriverBankLinkSessionSchema,
  })
  .strict();

export type StartDriverBankLinkResponse = z.infer<typeof StartDriverBankLinkResponseSchema>;

export const DriverBankAccountStatusResponseSchema = z
  .object({
    linked: z.boolean(),
  })
  .strict();

export type DriverBankAccountStatusResponse = z.infer<typeof DriverBankAccountStatusResponseSchema>;
