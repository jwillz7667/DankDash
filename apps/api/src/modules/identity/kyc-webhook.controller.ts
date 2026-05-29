/**
 * POST /v1/identity/kyc/webhook — Persona-driven KYC outcome ingest.
 *
 * Public (Persona has no bearer token to present). The endpoint is
 * authenticated by HMAC: PersonaService.handleWebhook recomputes
 * `HMAC-SHA256(secret, "${t}.${rawBody}")` and constant-time-compares it
 * against every `v1=` entry in the `Persona-Signature` header.
 *
 * The body MUST be read raw — re-serializing through Zod/JSON.parse would
 * change byte-for-byte content and invalidate the signature. NestJS exposes
 * the raw body through `@Req() req: RawBodyRequest<FastifyRequest>` when the
 * Fastify adapter is constructed with `rawBody: true` (set in main.ts).
 *
 * Response semantics:
 *
 *   - 204 No Content on every accepted, signed event — including ones whose
 *     event name we ignore (e.g. `inquiry.created`) and replays. Returning
 *     2xx drains Persona's retry queue; otherwise they keep retrying for 24h.
 *   - 4xx surfaces from KycError variants (bad signature, malformed payload,
 *     under-21 applicant) come through the global filter. Persona will retry
 *     on 5xx but not 4xx, which matches our intent — under-21 is a permanent
 *     rejection, not a transient failure.
 *
 * Idempotency: after signature + envelope validation we INSERT a row into
 * `webhook_events_processed` keyed by Persona's event id. ON CONFLICT
 * short-circuits the request — we ack the redelivery with 204 and skip the
 * `applyKycOutcome` side effects. Without this, Persona's 24h retry storm
 * would re-run the KYC status transition / audit writes on every redelivery.
 * Rows are TTL'd at 30 days by the nightly cron in apps/workers (covers the
 * 24h retry window with comfortable slack for human-driven replays).
 * Recording AFTER signature verification means a forged signature can never
 * plant a dedup row that would silence a future legitimate event with that id.
 */
import { WebhookEventsProcessedRepository } from '@dankdash/db';
import { KycError } from '@dankdash/types';
import {
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator.js';
import { IdentityService } from './identity.service.js';
import { PersonaService } from './persona/persona.service.js';
import type { FastifyRequest } from 'fastify';

const SIGNATURE_HEADER = 'persona-signature';
const PERSONA_PROVIDER = 'persona';
const DEDUP_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

@Controller('identity/kyc')
export class KycWebhookController {
  private readonly logger = new Logger(KycWebhookController.name);

  constructor(
    private readonly persona: PersonaService,
    private readonly identity: IdentityService,
    private readonly webhookEvents: WebhookEventsProcessedRepository,
  ) {}

  @Public()
  @Post('webhook')
  @HttpCode(HttpStatus.NO_CONTENT)
  async webhook(@Req() req: RawBodyRequest<FastifyRequest>): Promise<void> {
    const raw = req.rawBody;
    if (raw === undefined || raw.length === 0) {
      throw new KycError('KYC_WEBHOOK_PAYLOAD_INVALID', 'webhook body is empty');
    }
    const signature = req.headers[SIGNATURE_HEADER];
    if (typeof signature !== 'string' || signature.length === 0) {
      throw new KycError('KYC_WEBHOOK_SIGNATURE_INVALID', `missing ${SIGNATURE_HEADER} header`);
    }
    const outcome = this.persona.handleWebhook(raw.toString('utf8'), signature);
    const eventType = outcome.type === 'ignored' ? outcome.eventName : outcome.type;

    const { recorded } = await this.webhookEvents.recordIfAbsent({
      eventId: outcome.eventId,
      provider: PERSONA_PROVIDER,
      eventType,
      expiresAt: new Date(Date.now() + DEDUP_TTL_MS),
    });
    if (!recorded) {
      this.logger.log(
        `persona kyc webhook replay ignored event_id=${outcome.eventId} type=${eventType}`,
      );
      return;
    }

    await this.identity.applyKycOutcome(outcome);
  }
}
