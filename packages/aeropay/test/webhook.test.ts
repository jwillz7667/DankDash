/**
 * AeropayWebhookVerifier — HMAC signature, replay protection, envelope shape.
 *
 * The signature scheme mirrors the Persona webhook used in identity:
 * `t=<unix-seconds>,v1=<hex>`. These tests pin each branch of
 * `parseSignatureHeader` and `verifySignature` so a regression on the
 * timing-safe compare or the tolerance-window clamp is caught locally.
 */
import { createHmac } from 'node:crypto';
import { PaymentError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { AeropayWebhookVerifier } from '../src/webhook.js';

const SECRET = 'whsec_test_secret';
const NOW_SECONDS = 1_700_000_000;
const FROZEN_CLOCK = (): Date => new Date(NOW_SECONDS * 1000);

function sign(rawBody: string, secret = SECRET, ts = NOW_SECONDS): string {
  const sig = createHmac('sha256', secret)
    .update(`${String(ts)}.${rawBody}`)
    .digest('hex');
  return `t=${String(ts)},v1=${sig}`;
}

function envelope(
  overrides: Partial<{
    id: string;
    type: string;
    created_at: string;
    data: { object: { id: string; [k: string]: unknown }; [k: string]: unknown };
  }> = {},
): string {
  return JSON.stringify({
    id: overrides.id ?? 'evt_test_1',
    type: overrides.type ?? 'payment.authorized',
    created_at: overrides.created_at ?? '2026-01-01T00:00:00.000Z',
    data: overrides.data ?? { object: { id: 'pi_aeropay_1' } },
  });
}

describe('AeropayWebhookVerifier', () => {
  it('returns a typed outcome for a payment.authorized event with a valid signature', () => {
    const verifier = new AeropayWebhookVerifier({ webhookSecret: SECRET, clock: FROZEN_CLOCK });
    const body = envelope({ type: 'payment.authorized' });
    const header = sign(body);
    const outcome = verifier.verify(body, header);
    if (outcome.type === 'ignored') expect.fail('unexpected ignored outcome');
    expect(outcome.type).toBe('payment.authorized');
    expect(outcome.eventId).toBe('evt_test_1');
    expect(outcome.objectId).toBe('pi_aeropay_1');
    expect(outcome.occurredAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(outcome.raw['type']).toBe('payment.authorized');
  });

  it.each([
    'payment.settled',
    'payment.failed',
    'payment.canceled',
    'payment.refunded',
    'payout.paid',
    'payout.failed',
    'bank_account.linked',
    'bank_account.failed',
  ])('routes %s as a supported event', (eventType) => {
    const verifier = new AeropayWebhookVerifier({ webhookSecret: SECRET, clock: FROZEN_CLOCK });
    const body = envelope({ type: eventType });
    const outcome = verifier.verify(body, sign(body));
    expect(outcome.type).toBe(eventType);
  });

  it('routes an unknown event type as ignored (still 200 in the controller)', () => {
    const verifier = new AeropayWebhookVerifier({ webhookSecret: SECRET, clock: FROZEN_CLOCK });
    const body = envelope({ type: 'payment.something_new' });
    const outcome = verifier.verify(body, sign(body));
    expect(outcome.type).toBe('ignored');
    if (outcome.type !== 'ignored') expect.fail('unreachable');
    expect(outcome.eventName).toBe('payment.something_new');
    expect(outcome.eventId).toBe('evt_test_1');
  });

  it('accepts a second valid v1 alongside an invalid one (supports secret rotation)', () => {
    const verifier = new AeropayWebhookVerifier({ webhookSecret: SECRET, clock: FROZEN_CLOCK });
    const body = envelope();
    const goodSig = createHmac('sha256', SECRET)
      .update(`${String(NOW_SECONDS)}.${body}`)
      .digest('hex');
    const header = `t=${String(NOW_SECONDS)},v1=deadbeef,v1=${goodSig}`;
    expect(() => verifier.verify(body, header)).not.toThrow();
  });

  it('rejects a request with no v1 signature value', () => {
    const verifier = new AeropayWebhookVerifier({ webhookSecret: SECRET, clock: FROZEN_CLOCK });
    const body = envelope();
    expect(() => verifier.verify(body, `t=${String(NOW_SECONDS)}`)).toThrow(PaymentError);
  });

  it('rejects a request with no t timestamp', () => {
    const verifier = new AeropayWebhookVerifier({ webhookSecret: SECRET, clock: FROZEN_CLOCK });
    const body = envelope();
    const sig = createHmac('sha256', SECRET)
      .update(`${String(NOW_SECONDS)}.${body}`)
      .digest('hex');
    expect(() => verifier.verify(body, `v1=${sig}`)).toThrow(PaymentError);
  });

  it('rejects a t value that contains non-digits (no parseInt prefix attack)', () => {
    const verifier = new AeropayWebhookVerifier({ webhookSecret: SECRET, clock: FROZEN_CLOCK });
    const body = envelope();
    const sig = createHmac('sha256', SECRET)
      .update(`${String(NOW_SECONDS)}.${body}`)
      .digest('hex');
    expect(() => verifier.verify(body, `t=${String(NOW_SECONDS)}xy,v1=${sig}`)).toThrow(
      /missing t=/,
    );
  });

  it('rejects malformed header parts that have no = sign', () => {
    const verifier = new AeropayWebhookVerifier({ webhookSecret: SECRET, clock: FROZEN_CLOCK });
    const body = envelope();
    expect(() => verifier.verify(body, 'garbage')).toThrow(/missing t=/);
  });

  it('skips parts whose key is empty (the leading "=" branch)', () => {
    const verifier = new AeropayWebhookVerifier({ webhookSecret: SECRET, clock: FROZEN_CLOCK });
    const body = envelope();
    const sig = createHmac('sha256', SECRET)
      .update(`${String(NOW_SECONDS)}.${body}`)
      .digest('hex');
    // Leading "=value" parts have eqIdx === 0 and must be skipped without
    // breaking the rest of the parse.
    const header = `=junk,t=${String(NOW_SECONDS)},v1=${sig}`;
    expect(() => verifier.verify(body, header)).not.toThrow();
  });

  it('rejects a stale timestamp outside the tolerance window', () => {
    const verifier = new AeropayWebhookVerifier({
      webhookSecret: SECRET,
      toleranceSeconds: 60,
      clock: FROZEN_CLOCK,
    });
    const body = envelope();
    const stale = NOW_SECONDS - 1_000;
    const sig = createHmac('sha256', SECRET)
      .update(`${String(stale)}.${body}`)
      .digest('hex');
    expect(() => verifier.verify(body, `t=${String(stale)},v1=${sig}`)).toThrow(/tolerance/);
  });

  it('rejects when the v1 hex has the wrong byte length', () => {
    const verifier = new AeropayWebhookVerifier({ webhookSecret: SECRET, clock: FROZEN_CLOCK });
    const body = envelope();
    // 16-byte sig instead of 32-byte SHA-256 — Buffer.from succeeds but
    // length-compare drops it.
    const wrongLen = 'deadbeef'.repeat(4);
    expect(() => verifier.verify(body, `t=${String(NOW_SECONDS)},v1=${wrongLen}`)).toThrow(
      /verification failed/,
    );
  });

  it('rejects when the v1 hex is not actually hex', () => {
    const verifier = new AeropayWebhookVerifier({ webhookSecret: SECRET, clock: FROZEN_CLOCK });
    const body = envelope();
    expect(() => verifier.verify(body, `t=${String(NOW_SECONDS)},v1=ZZZZ`)).toThrow(
      /verification failed/,
    );
  });

  it('rejects a forged signature signed with the wrong secret', () => {
    const verifier = new AeropayWebhookVerifier({ webhookSecret: SECRET, clock: FROZEN_CLOCK });
    const body = envelope();
    expect(() => verifier.verify(body, sign(body, 'wrong-secret'))).toThrow(/verification failed/);
  });

  it('rejects a body whose JSON is malformed', () => {
    const verifier = new AeropayWebhookVerifier({ webhookSecret: SECRET, clock: FROZEN_CLOCK });
    const body = '{not-json';
    expect(() => verifier.verify(body, sign(body))).toThrow(/not valid JSON/);
  });

  it('rejects an envelope missing required fields', () => {
    const verifier = new AeropayWebhookVerifier({ webhookSecret: SECRET, clock: FROZEN_CLOCK });
    const body = JSON.stringify({ id: 'evt' }); // no type/created_at/data
    expect(() => verifier.verify(body, sign(body))).toThrow(/schema validation/);
  });

  it('uses the system clock when no override is supplied', () => {
    const verifier = new AeropayWebhookVerifier({ webhookSecret: SECRET });
    // Signing with the current wall-clock time should pass — we don't
    // assert exact equality of `occurredAt`, just that no tolerance
    // error is raised.
    const now = Math.floor(Date.now() / 1000);
    const body = envelope({ created_at: new Date(now * 1000).toISOString() });
    const sig = createHmac('sha256', SECRET)
      .update(`${String(now)}.${body}`)
      .digest('hex');
    expect(() => verifier.verify(body, `t=${String(now)},v1=${sig}`)).not.toThrow();
  });
});
