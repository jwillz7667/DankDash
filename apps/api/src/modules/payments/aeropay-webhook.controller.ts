/**
 * POST /v1/payment-methods/aeropay/webhook — Aeropay-driven bank-link and
 * payment-lifecycle ingest.
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
 *     ignore and replays. 2xx drains Aeropay's retry queue; otherwise they
 *     retry with exponential backoff for 72 hours.
 *   - 401 from a missing / mismatching signature surfaces via
 *     `PaymentError('PAYMENT_WEBHOOK_SIGNATURE_INVALID')` and the global
 *     filter. Aeropay treats 4xx as terminal, which matches our intent —
 *     a forged or expired signature is permanent, not transient.
 *   - 5xx (genuine bugs) goes through to Aeropay's retry queue.
 *
 * Idempotency (Phase 6.7): after signature + envelope validation we
 * INSERT a row into `webhook_events_processed` keyed by Aeropay's
 * `eventId`. ON CONFLICT short-circuits the request — we ack the
 * redelivery with 204 and skip the service call. Rows are TTL'd at 30
 * days by the nightly cron in apps/workers (covers Aeropay's 72h retry
 * window with comfortable slack for human-driven replays). Recording
 * AFTER signature verification means a forged signature never plants a
 * dedup row that would silence a future legitimate event with that id.
 */
import { WebhookEventsProcessedRepository } from '@dankdash/db';
import { PaymentError } from '@dankdash/types';
import {
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator.js';
import { PaymentMethodsService } from './payment-methods.service.js';
import { AEROPAY_WEBHOOK_VERIFIER, type AeropayWebhookVerifierLike } from './tokens.js';
import type { FastifyRequest } from 'fastify';

const SIGNATURE_HEADER = 'aeropay-signature';
const AEROPAY_PROVIDER = 'aeropay';
const DEDUP_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

@Controller('payment-methods/aeropay')
export class AeropayWebhookController {
  private readonly logger = new Logger(AeropayWebhookController.name);

  constructor(
    @Inject(AEROPAY_WEBHOOK_VERIFIER) private readonly verifier: AeropayWebhookVerifierLike,
    private readonly service: PaymentMethodsService,
    private readonly webhookEvents: WebhookEventsProcessedRepository,
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
    const eventType = outcome.type === 'ignored' ? outcome.eventName : outcome.type;

    const { recorded } = await this.webhookEvents.recordIfAbsent({
      eventId: outcome.eventId,
      provider: AEROPAY_PROVIDER,
      eventType,
      expiresAt: new Date(Date.now() + DEDUP_TTL_MS),
    });
    if (!recorded) {
      this.logger.log(
        `aeropay webhook replay ignored event_id=${outcome.eventId} type=${eventType}`,
      );
      return;
    }

    await this.service.applyWebhook(outcome);
  }
}
