/**
 * AeropayWebhookController unit tests.
 *
 * The controller is the auth boundary for Aeropay-driven events: it
 * (1) reads the raw body, (2) extracts the Aeropay-Signature header,
 * (3) hands both off to the verifier, and (4) forwards the verified
 * outcome to PaymentMethodsService. These tests pin every branch on the
 * pre-verifier path plus the happy-path forward.
 */
import { type AeropayWebhookOutcome } from '@dankdash/aeropay';
import { PaymentError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { AeropayWebhookController } from './aeropay-webhook.controller.js';
import type { PaymentMethodsService } from './payment-methods.service.js';
import type { AeropayWebhookVerifierLike } from './tokens.js';
import type { RawBodyRequest } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

class FakeVerifier implements AeropayWebhookVerifierLike {
  calls: Array<{ rawBody: string; signature: string }> = [];
  nextOutcome: AeropayWebhookOutcome = { type: 'ignored', eventId: 'evt_x', eventName: 'noop' };
  shouldThrow: PaymentError | null = null;

  verify = (rawBody: string, signature: string): AeropayWebhookOutcome => {
    this.calls.push({ rawBody, signature });
    if (this.shouldThrow !== null) throw this.shouldThrow;
    return this.nextOutcome;
  };
}

class FakeService {
  calls: AeropayWebhookOutcome[] = [];
  applyWebhook = (outcome: AeropayWebhookOutcome): Promise<void> => {
    this.calls.push(outcome);
    return Promise.resolve();
  };
}

function makeRequest(
  rawBody: Buffer | undefined,
  signature: string | undefined,
): RawBodyRequest<FastifyRequest> {
  return {
    rawBody,
    headers: signature === undefined ? {} : { 'aeropay-signature': signature },
  } as unknown as RawBodyRequest<FastifyRequest>;
}

function build(): {
  controller: AeropayWebhookController;
  verifier: FakeVerifier;
  service: FakeService;
} {
  const verifier = new FakeVerifier();
  const service = new FakeService();
  const controller = new AeropayWebhookController(
    verifier,
    service as unknown as PaymentMethodsService,
  );
  return { controller, verifier, service };
}

describe('AeropayWebhookController', () => {
  it('forwards rawBody + signature to the verifier and applies the outcome', async () => {
    const { controller, verifier, service } = build();
    const raw = Buffer.from(
      '{"id":"evt_1","type":"bank_account.linked","created_at":"2026-05-01T00:00:00.000Z","data":{"object":{"id":"ba_test_1"}}}',
      'utf8',
    );
    verifier.nextOutcome = {
      type: 'bank_account.linked',
      eventId: 'evt_1',
      objectId: 'ba_test_1',
      occurredAt: new Date('2026-05-01T00:00:00.000Z'),
      raw: {},
    };

    await controller.webhook(makeRequest(raw, 't=1700000000,v1=abcdef'));

    expect(verifier.calls).toEqual([
      { rawBody: raw.toString('utf8'), signature: 't=1700000000,v1=abcdef' },
    ]);
    expect(service.calls).toEqual([verifier.nextOutcome]);
  });

  it('rejects when rawBody is missing entirely', async () => {
    const { controller, verifier } = build();

    await expect(
      controller.webhook(makeRequest(undefined, 't=1700000000,v1=abc')),
    ).rejects.toMatchObject({ code: 'PAYMENT_WEBHOOK_SIGNATURE_INVALID' });
    expect(verifier.calls).toHaveLength(0);
  });

  it('rejects when rawBody is an empty buffer', async () => {
    const { controller, verifier } = build();

    await expect(
      controller.webhook(makeRequest(Buffer.alloc(0), 't=1700000000,v1=abc')),
    ).rejects.toBeInstanceOf(PaymentError);
    expect(verifier.calls).toHaveLength(0);
  });

  it('rejects when the aeropay-signature header is missing', async () => {
    const { controller } = build();

    await expect(
      controller.webhook(makeRequest(Buffer.from('{}'), undefined)),
    ).rejects.toMatchObject({ code: 'PAYMENT_WEBHOOK_SIGNATURE_INVALID' });
  });

  it('propagates the verifier PaymentError when the signature is invalid', async () => {
    const { controller, verifier, service } = build();
    verifier.shouldThrow = new PaymentError(
      'PAYMENT_WEBHOOK_SIGNATURE_INVALID',
      'verification failed',
      {},
      401,
    );

    await expect(
      controller.webhook(makeRequest(Buffer.from('{}'), 't=1700000000,v1=garbage')),
    ).rejects.toBeInstanceOf(PaymentError);
    expect(service.calls).toHaveLength(0);
  });
});
