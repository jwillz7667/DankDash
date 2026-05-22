/**
 * POST /v1/webhooks/veriff — Veriff-driven decision ingest.
 *
 * Public (Veriff has no bearer token to present). Authentication is
 * HMAC: VeriffClient.handleWebhook recomputes
 * `HMAC-SHA256(secret, rawBody)` and constant-time-compares against the
 * hex digest in the `X-HMAC-SIGNATURE` header.
 *
 * Lives in DriversModule (not IdentityVerificationModule) for one
 * reason: the orchestrating write surface (`DriverIdScanService`)
 * sits in this module, and routing the webhook through the same
 * module keeps the dependency graph one-way (drivers → identity-
 * verification) instead of mutually recursive. The plan called for
 * `apps/api/src/modules/identity-verification/veriff-webhook.controller.ts`
 * but the controller is purely a thin HMAC + dispatch — the actual
 * intent (mutate an order's id-scan state) is a driver-feature
 * concern, so the location matches the responsibility.
 *
 * The body MUST be read raw — re-serializing through Zod / JSON.parse
 * would change byte ordering and invalidate the signature. NestJS
 * exposes the raw body through
 * `@Req() req: RawBodyRequest<FastifyRequest>` when the Fastify
 * adapter is constructed with `rawBody: true` (set in main.ts).
 *
 * Response semantics:
 *
 *   - 204 No Content on every signed event, including ones whose
 *     status we ignore (`pending`). Veriff drains its retry queue on
 *     2xx and keeps retrying for 24h on 5xx.
 *
 *   - 4xx (signature / payload failures) surface from KycError
 *     variants via the global filter. Veriff treats 4xx as terminal
 *     which matches our intent — a forged signature is not a
 *     transient condition.
 *
 * Idempotency is enforced by
 * `AgeVerificationsRepository.recordIdempotent` — the unique constraint
 * on (provider, provider_session_id) makes a retry storm on the same
 * verification id a no-op.
 */
import { KycError } from '@dankdash/types';
import { Controller, HttpCode, HttpStatus, Post, Req, type RawBodyRequest } from '@nestjs/common';
import { Public } from '../../../common/decorators/public.decorator.js';
import { VeriffClient } from '../../identity-verification/veriff.client.js';
import { DriverIdScanService } from '../services/driver-id-scan.service.js';
import type { FastifyRequest } from 'fastify';

const SIGNATURE_HEADER = 'x-hmac-signature';

@Controller('webhooks/veriff')
export class VeriffWebhookController {
  constructor(
    private readonly veriff: VeriffClient,
    private readonly driverIdScan: DriverIdScanService,
  ) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  async webhook(@Req() req: RawBodyRequest<FastifyRequest>): Promise<void> {
    const raw = req.rawBody;
    if (raw === undefined || raw.length === 0) {
      throw new KycError('KYC_WEBHOOK_PAYLOAD_INVALID', 'Veriff webhook body is empty');
    }
    const headerValue = req.headers[SIGNATURE_HEADER];
    const signature = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (typeof signature !== 'string' || signature.length === 0) {
      throw new KycError('KYC_WEBHOOK_SIGNATURE_INVALID', `missing ${SIGNATURE_HEADER} header`);
    }
    const decision = this.veriff.handleWebhook(raw.toString('utf8'), signature);
    await this.driverIdScan.applyWebhookDecision(decision);
  }
}
