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
 *     event name we ignore (e.g. `inquiry.created`). Returning 2xx drains
 *     Persona's retry queue; otherwise they keep retrying for 24h.
 *   - 4xx surfaces from KycError variants (bad signature, malformed payload,
 *     under-21 applicant) come through the global filter. Persona will retry
 *     on 5xx but not 4xx, which matches our intent — under-21 is a permanent
 *     rejection, not a transient failure.
 */
import { KycError } from '@dankdash/types';
import { Controller, HttpCode, HttpStatus, Post, Req, type RawBodyRequest } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator.js';
import { IdentityService } from './identity.service.js';
import { PersonaService } from './persona/persona.service.js';
import type { FastifyRequest } from 'fastify';

const SIGNATURE_HEADER = 'persona-signature';

@Controller('identity/kyc')
export class KycWebhookController {
  constructor(
    private readonly persona: PersonaService,
    private readonly identity: IdentityService,
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
    await this.identity.applyKycOutcome(outcome);
  }
}
