/**
 * /v1/identity/kyc/* DTOs.
 *
 *   POST /v1/identity/kyc/start   — authenticated. No body. Returns the
 *                                   Persona hosted-flow URL the iOS client
 *                                   opens in an SFSafariViewController.
 *
 *   POST /v1/identity/kyc/webhook — UNAUTHENTICATED. Signature-verified by
 *                                   PersonaService.handleWebhook using
 *                                   PERSONA_WEBHOOK_SECRET. The body is
 *                                   Persona's JSON:API event envelope; we
 *                                   declare its shape loosely here because
 *                                   the strict parse happens inside the
 *                                   service against a schema that also
 *                                   tolerates future Persona additions.
 *
 * The webhook DTO doesn't use createZodDto because the controller needs
 * the *raw* request body (Buffer / string) to recompute the HMAC. The
 * Zod schema below documents the expected envelope for callers — but the
 * controller path uses @RawBody() and forwards to the service unchanged.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const KycStartResponseSchema = z
  .object({
    inquiryId: z.string().min(1),
    inquiryUrl: z.string().url(),
  })
  .strict();

export type KycStartResponse = z.infer<typeof KycStartResponseSchema>;

/**
 * Documentation-only schema for the Persona webhook envelope. The
 * controller forwards the raw body to PersonaService.handleWebhook, which
 * holds the authoritative parser (it must verify the signature against
 * the exact bytes the client sent — re-serializing a Zod-parsed object
 * would invalidate the HMAC).
 */
export const KycWebhookEnvelopeSchema = z
  .object({
    data: z
      .object({
        type: z.string(),
        attributes: z
          .object({
            name: z.string(),
            payload: z.unknown(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

export type KycWebhookEnvelope = z.infer<typeof KycWebhookEnvelopeSchema>;

/**
 * No request body for /kyc/start, but a marker DTO keeps the controller
 * signature uniform — the Zod pipe ignores classes with no `schema`.
 *
 * The webhook endpoint returns 204 No Content on every accepted signed
 * event (including ignored event names) to drain Persona's retry queue;
 * the controller emits this directly with @HttpCode(204) — no DTO needed.
 */
export class KycStartRequestDto extends createZodDto(z.object({}).strict()) {}
