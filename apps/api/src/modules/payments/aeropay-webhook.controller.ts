/**
 * POST /v1/payment-methods/aeropay/webhook — Aeropay-driven bank-link and
 * (eventually, Phase 6.3) payment-lifecycle ingest.
 *
 * Public (Aeropay presents no bearer token). The endpoint is authenticated
 * by HMAC: AeropayWebhookVerifier recomputes
 * `HMAC-SHA256(secret, "${t}.${rawBody}")` and constant-time-compares it
 * against every `v1=` entry in the `Aeropay-Signature` header. The body
 * MUST be read raw — re-serializing through Zod/JSON.parse changes the
 * byte content and invalidates the signature. NestJS exposes
 * `req.rawBody` when the Fastify adapter is constructed with `rawBody:
 * true`, set in `main.ts`.
 *
 * Response semantics:
 *
 *   - 204 No Content on every signed event — including ones whose name we
 *     ignore. 2xx drains Aeropay's retry queue; otherwise they retry with
 *     exponential backoff for 72 hours.
 *   - 401 from a missing / mismatching signature surfaces via
 *     `PaymentError('PAYMENT_WEBHOOK_SIGNATURE_INVALID')` and the global
 *     filter. Aeropay treats 4xx as terminal, which matches our intent —
 *     a forged or expired signature is permanent, not transient.
 *   - 5xx (genuine bugs) goes through to Aeropay's retry queue.
 *
 * Why this controller doesn't dedupe yet: Phase 6.7 introduces a
 * `webhook_events_processed` table that records each `event_id` for 30
 * days; the service-layer handlers in `PaymentMethodsService.applyWebhook`
 * are idempotent by construction (re-applying `bank_account.linked` on an
 * already-active row is a no-op) so the missing controller-level dedup is
 * a defense-in-depth gap, not a correctness gap.
 */
import { PaymentError } from '@dankdash/types';
import {
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator.js';
import { PaymentMethodsService } from './payment-methods.service.js';
import { AEROPAY_WEBHOOK_VERIFIER, type AeropayWebhookVerifierLike } from './tokens.js';
import type { FastifyRequest } from 'fastify';

const SIGNATURE_HEADER = 'aeropay-signature';

@Controller('payment-methods/aeropay')
export class AeropayWebhookController {
  constructor(
    @Inject(AEROPAY_WEBHOOK_VERIFIER) private readonly verifier: AeropayWebhookVerifierLike,
    private readonly service: PaymentMethodsService,
  ) {}

  @Public()
  @Post('webhook')
  @HttpCode(HttpStatus.NO_CONTENT)
  async webhook(@Req() req: RawBodyRequest<FastifyRequest>): Promise<void> {
    const raw = req.rawBody;
    if (raw === undefined || raw.length === 0) {
      throw new PaymentError('PAYMENT_WEBHOOK_SIGNATURE_INVALID', 'webhook body is empty', {}, 401);
    }
    const signature = req.headers[SIGNATURE_HEADER];
    if (typeof signature !== 'string' || signature.length === 0) {
      throw new PaymentError(
        'PAYMENT_WEBHOOK_SIGNATURE_INVALID',
        `missing ${SIGNATURE_HEADER} header`,
        {},
        401,
      );
    }
    const outcome = this.verifier.verify(raw.toString('utf8'), signature);
    await this.service.applyWebhook(outcome);
  }
}
