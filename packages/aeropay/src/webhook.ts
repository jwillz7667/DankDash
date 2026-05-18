/**
 * Aeropay webhook signature verification + payload parsing.
 *
 * Aeropay signs webhooks with HMAC-SHA256 over `${timestamp}.${rawBody}`,
 * delivered in the `Aeropay-Signature` header in the form
 * `t=<unix-seconds>,v1=<hex>[,v1=<hex>]` — multi-value `v1=` supports
 * webhook-secret rotation without dropped events (both the old and new
 * secret are accepted during the cutover window).
 *
 * The verifier mirrors the Persona webhook flow used in
 * `apps/api/src/modules/identity/persona/persona.service.ts`:
 *   1. Parse the signature header strictly (no `parseInt('123abc')` leakage).
 *   2. Reject timestamps outside the tolerance window (default ±300s) so
 *      a captured webhook cannot be replayed days later if the body and
 *      sig leak from a log.
 *   3. Constant-time compare each candidate sig against the expected HMAC.
 *      A mismatch raises `PAYMENT_WEBHOOK_SIGNATURE_INVALID` (renders 401).
 *   4. Parse the JSON envelope through a Zod schema; the unmatched event
 *      shape is surfaced as `'ignored'` rather than thrown so we can return
 *      200 and stop Aeropay's retry storm.
 *
 * Idempotency: this verifier returns `eventId` so the controller can
 * de-dupe via `webhook_events_processed` before applying side effects.
 * The verifier itself is stateless.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PaymentError } from '@dankdash/types';
import { WebhookEnvelopeSchema } from './schemas.js';
import { type AeropayWebhookEventType, type AeropayWebhookOutcome } from './types.js';

const DEFAULT_TOLERANCE_SECONDS = 300;

const SUPPORTED_EVENT_TYPES: ReadonlySet<AeropayWebhookEventType> = new Set([
  'payment.authorized',
  'payment.settled',
  'payment.failed',
  'payment.canceled',
  'payment.refunded',
  'payout.paid',
  'payout.failed',
  'bank_account.linked',
  'bank_account.failed',
]);

export interface AeropayWebhookVerifierConfig {
  readonly webhookSecret: string;
  readonly toleranceSeconds?: number;
  readonly clock?: () => Date;
}

export class AeropayWebhookVerifier {
  private readonly webhookSecret: string;
  private readonly toleranceSeconds: number;
  private readonly clock: () => Date;

  constructor(config: AeropayWebhookVerifierConfig) {
    this.webhookSecret = config.webhookSecret;
    this.toleranceSeconds = config.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
    this.clock = config.clock ?? ((): Date => new Date());
  }

  /**
   * Throws `PaymentError('PAYMENT_WEBHOOK_SIGNATURE_INVALID')` if the
   * signature, timestamp, or payload envelope cannot be validated.
   * Otherwise returns a typed outcome that the controller dispatches on.
   */
  verify(rawBody: string, signatureHeader: string): AeropayWebhookOutcome {
    this.verifySignature(rawBody, signatureHeader);

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch (err) {
      throw new PaymentError(
        'PAYMENT_WEBHOOK_SIGNATURE_INVALID',
        'webhook body is not valid JSON',
        {},
        401,
        err,
      );
    }

    const parsed = WebhookEnvelopeSchema.safeParse(json);
    if (!parsed.success) {
      throw new PaymentError(
        'PAYMENT_WEBHOOK_SIGNATURE_INVALID',
        'webhook envelope failed schema validation',
        {
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
        401,
      );
    }

    const envelope = parsed.data;
    const eventName = envelope.type;
    const eventId = envelope.id;
    const occurredAt = new Date(envelope.created_at);
    const objectId = envelope.data.object.id;

    if (!isSupportedEventType(eventName)) {
      return { type: 'ignored', eventName, eventId };
    }

    return {
      type: eventName,
      eventId,
      objectId,
      occurredAt,
      raw: envelope,
    };
  }

  private verifySignature(rawBody: string, signatureHeader: string): void {
    const { timestamp, signatures } = parseSignatureHeader(signatureHeader);
    if (timestamp === null || signatures.length === 0) {
      throw new PaymentError(
        'PAYMENT_WEBHOOK_SIGNATURE_INVALID',
        'webhook signature header missing t= or v1=',
        {},
        401,
      );
    }

    const nowSeconds = Math.floor(this.clock().getTime() / 1000);
    if (Math.abs(nowSeconds - timestamp) > this.toleranceSeconds) {
      throw new PaymentError(
        'PAYMENT_WEBHOOK_SIGNATURE_INVALID',
        'webhook timestamp outside tolerance',
        { received: timestamp, now: nowSeconds, toleranceSeconds: this.toleranceSeconds },
        401,
      );
    }

    const expected = createHmac('sha256', this.webhookSecret)
      .update(`${String(timestamp)}.${rawBody}`)
      .digest();

    const matched = signatures.some((candidateHex) => {
      // `Buffer.from(_, 'hex')` does not throw on invalid hex — it stops
      // decoding at the first non-hex byte. A bad sig therefore yields
      // either an empty buffer or one with the wrong length; both fail
      // the length check below without false-matching `expected`.
      const candidate = Buffer.from(candidateHex, 'hex');
      if (candidate.length !== expected.length) return false;
      return timingSafeEqual(candidate, expected);
    });

    if (!matched) {
      throw new PaymentError(
        'PAYMENT_WEBHOOK_SIGNATURE_INVALID',
        'webhook signature verification failed',
        {},
        401,
      );
    }
  }
}

interface ParsedSignatureHeader {
  readonly timestamp: number | null;
  readonly signatures: readonly string[];
}

function parseSignatureHeader(header: string): ParsedSignatureHeader {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const rawPart of header.split(',')) {
    const part = rawPart.trim();
    const eqIdx = part.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = part.slice(0, eqIdx);
    const value = part.slice(eqIdx + 1);
    if (key === 't') {
      // Strict integer check — `parseInt('123abc')` returns 123 which
      // would be a bug here (an attacker-controlled value could pass a
      // numeric-looking prefix to coast through the tolerance window).
      if (/^\d+$/.test(value)) {
        timestamp = Number.parseInt(value, 10);
      }
    } else if (key === 'v1') {
      signatures.push(value);
    }
  }
  return { timestamp, signatures };
}

function isSupportedEventType(name: string): name is AeropayWebhookEventType {
  return (SUPPORTED_EVENT_TYPES as ReadonlySet<string>).has(name);
}
