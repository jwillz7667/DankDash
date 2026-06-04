/**
 * DTOs for the driver-facing ID-scan endpoints and the Veriff webhook.
 *
 *   POST /v1/driver/orders/:id/id-scan-session   (driver-self)
 *     Request:  no body — order id from path, driver from JWT.
 *     Response: { verificationId, sessionUrl, sessionToken } — iOS hands
 *               sessionToken to the Veriff SDK to launch the flow.
 *
 *   POST /v1/driver/orders/:id/id-scan-result    (driver-self)
 *     Request:  { verificationId } — iOS reports which session it
 *               completed against. The backend fetches the
 *               authoritative decision from Veriff (we do NOT trust
 *               the SDK callback alone; the driver could fake an
 *               approval) and writes the outcome to age_verifications
 *               + orders.
 *     Response: the full DriverOrderDetailResponse with the freshly
 *               updated idScan block, so iOS renders without a
 *               follow-up GET.
 *
 *   POST /v1/webhooks/veriff                     (Veriff-driven, public)
 *     Request:  raw JSON; signature in X-HMAC-SIGNATURE header. The
 *               webhook controller reads `req.rawBody` and hands it to
 *               VeriffClient.handleWebhook without re-serializing —
 *               JSON.stringify would change byte ordering and break
 *               the signature.
 *     Response: 204 No Content on every signed event, even ignored
 *               ones, so Veriff stops retrying. 4xx surfaces from
 *               KycError variants.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Driver-supplied verification id on the result endpoint. The session
 * id we issued is the same one the SDK echoes back; this lets us
 * cross-check that the driver isn't reporting against a stale or
 * unrelated session. The server still queries Veriff for the real
 * decision — the body is a hint, not a source of truth.
 */
export const DriverIdScanResultRequestSchema = z
  .object({
    verificationId: z.string().min(1).max(64),
  })
  .strict();

export type DriverIdScanResultRequest = z.infer<typeof DriverIdScanResultRequestSchema>;

export class DriverIdScanResultRequestDto extends createZodDto(DriverIdScanResultRequestSchema) {}

export const DriverIdScanSessionResponseSchema = z
  .object({
    verificationId: z.string().min(1),
    sessionUrl: z.string().url(),
    sessionToken: z.string().min(1),
  })
  .strict();

export type DriverIdScanSessionResponse = z.infer<typeof DriverIdScanSessionResponseSchema>;
