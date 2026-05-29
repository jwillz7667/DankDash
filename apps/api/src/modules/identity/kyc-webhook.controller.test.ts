/**
 * KycWebhookController unit tests.
 *
 * The controller is the auth boundary for Persona-driven KYC events: it
 * (1) reads the raw body, (2) extracts the Persona-Signature header,
 * (3) hands both off to PersonaService.handleWebhook, (4) records an
 * idempotency row keyed by Persona's event id, and (5) forwards the
 * verified outcome to IdentityService.applyKycOutcome — or returns
 * silently on a replay.
 *
 * These tests pin every branch on the pre-verify path, the dedup fork
 * (first delivery vs replay), and the happy-path forward.
 */
import { KycError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { KycWebhookController } from './kyc-webhook.controller.js';
import type { IdentityService } from './identity.service.js';
import type { PersonaService, WebhookOutcome } from './persona/persona.service.js';
import type { WebhookEventProcessed, WebhookEventsProcessedRepository } from '@dankdash/db';
import type { RawBodyRequest } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

class FakePersona {
  calls: Array<{ rawBody: string; signature: string }> = [];
  nextOutcome: WebhookOutcome = { type: 'ignored', eventId: 'evt_x', eventName: 'inquiry.created' };
  shouldThrow: KycError | null = null;

  handleWebhook = (rawBody: string, signature: string): WebhookOutcome => {
    this.calls.push({ rawBody, signature });
    if (this.shouldThrow !== null) throw this.shouldThrow;
    return this.nextOutcome;
  };
}

class FakeIdentity {
  calls: WebhookOutcome[] = [];
  applyKycOutcome = (outcome: WebhookOutcome): Promise<void> => {
    this.calls.push(outcome);
    return Promise.resolve();
  };
}

interface RecordIfAbsentInput {
  readonly eventId: string;
  readonly provider: string;
  readonly eventType: string;
  readonly expiresAt: Date;
}

class FakeWebhookEventsRepo {
  calls: RecordIfAbsentInput[] = [];
  seen = new Map<string, WebhookEventProcessed>();

  recordIfAbsent = (
    input: RecordIfAbsentInput,
  ): Promise<{ readonly recorded: boolean; readonly existing: WebhookEventProcessed | null }> => {
    this.calls.push(input);
    const existing = this.seen.get(input.eventId);
    if (existing !== undefined) {
      return Promise.resolve({ recorded: false, existing });
    }
    const row: WebhookEventProcessed = {
      eventId: input.eventId,
      provider: input.provider,
      eventType: input.eventType,
      receivedAt: new Date(),
      expiresAt: input.expiresAt,
    };
    this.seen.set(input.eventId, row);
    return Promise.resolve({ recorded: true, existing: null });
  };
}

function makeRequest(
  rawBody: Buffer | undefined,
  signature: string | undefined,
): RawBodyRequest<FastifyRequest> {
  return {
    rawBody,
    headers: signature === undefined ? {} : { 'persona-signature': signature },
  } as unknown as RawBodyRequest<FastifyRequest>;
}

function build(): {
  controller: KycWebhookController;
  persona: FakePersona;
  identity: FakeIdentity;
  webhookEvents: FakeWebhookEventsRepo;
} {
  const persona = new FakePersona();
  const identity = new FakeIdentity();
  const webhookEvents = new FakeWebhookEventsRepo();
  const controller = new KycWebhookController(
    persona as unknown as PersonaService,
    identity as unknown as IdentityService,
    webhookEvents as unknown as WebhookEventsProcessedRepository,
  );
  return { controller, persona, identity, webhookEvents };
}

describe('KycWebhookController', () => {
  it('forwards rawBody + signature to persona and applies the outcome', async () => {
    const { controller, persona, identity, webhookEvents } = build();
    const raw = Buffer.from('{"data":{"id":"evt_1"}}', 'utf8');
    persona.nextOutcome = {
      type: 'kyc.completed',
      eventId: 'evt_1',
      userId: 'user_aaa',
      inquiryId: 'inq_1',
      dateOfBirth: '1990-01-15',
    };

    await controller.webhook(makeRequest(raw, 't=1700000000,v1=abcdef'));

    expect(persona.calls).toEqual([
      { rawBody: raw.toString('utf8'), signature: 't=1700000000,v1=abcdef' },
    ]);
    expect(identity.calls).toEqual([persona.nextOutcome]);
    expect(webhookEvents.calls).toHaveLength(1);
    expect(webhookEvents.calls[0]).toMatchObject({
      eventId: 'evt_1',
      provider: 'persona',
      eventType: 'kyc.completed',
    });
  });

  it('rejects when rawBody is missing entirely', async () => {
    const { controller, persona } = build();

    await expect(
      controller.webhook(makeRequest(undefined, 't=1700000000,v1=abc')),
    ).rejects.toMatchObject({ code: 'KYC_WEBHOOK_PAYLOAD_INVALID' });
    expect(persona.calls).toHaveLength(0);
  });

  it('rejects when rawBody is an empty buffer', async () => {
    const { controller, persona } = build();

    await expect(
      controller.webhook(makeRequest(Buffer.alloc(0), 't=1700000000,v1=abc')),
    ).rejects.toBeInstanceOf(KycError);
    expect(persona.calls).toHaveLength(0);
  });

  it('rejects when the persona-signature header is missing', async () => {
    const { controller } = build();

    await expect(
      controller.webhook(makeRequest(Buffer.from('{}'), undefined)),
    ).rejects.toMatchObject({ code: 'KYC_WEBHOOK_SIGNATURE_INVALID' });
  });

  it('propagates the KycError when persona rejects the signature, recording nothing', async () => {
    const { controller, persona, identity, webhookEvents } = build();
    persona.shouldThrow = new KycError(
      'KYC_WEBHOOK_SIGNATURE_INVALID',
      'webhook signature verification failed',
    );

    await expect(
      controller.webhook(makeRequest(Buffer.from('{}'), 't=1700000000,v1=garbage')),
    ).rejects.toBeInstanceOf(KycError);
    expect(identity.calls).toHaveLength(0);
    expect(webhookEvents.calls).toHaveLength(0);
  });

  it('returns silently and skips applyKycOutcome when the event id is a replay', async () => {
    const { controller, persona, identity, webhookEvents } = build();
    const raw = Buffer.from('{"data":{"id":"evt_dup"}}', 'utf8');
    persona.nextOutcome = {
      type: 'kyc.completed',
      eventId: 'evt_dup',
      userId: 'user_aaa',
      inquiryId: 'inq_dup',
      dateOfBirth: '1990-01-15',
    };

    await controller.webhook(makeRequest(raw, 't=1700000000,v1=first'));
    await controller.webhook(makeRequest(raw, 't=1700000001,v1=second'));

    expect(persona.calls).toHaveLength(2);
    expect(webhookEvents.calls).toHaveLength(2);
    expect(identity.calls).toHaveLength(1);
    expect(identity.calls[0]?.eventId).toBe('evt_dup');
  });

  it('records ignored events under their event name so unknown replays still dedup', async () => {
    const { controller, persona, identity, webhookEvents } = build();
    const raw = Buffer.from('{"data":{"id":"evt_ignored"}}', 'utf8');
    persona.nextOutcome = {
      type: 'ignored',
      eventId: 'evt_ignored',
      eventName: 'inquiry.created',
    };

    await controller.webhook(makeRequest(raw, 't=1700000000,v1=ign'));

    expect(webhookEvents.calls).toHaveLength(1);
    expect(webhookEvents.calls[0]).toMatchObject({
      eventId: 'evt_ignored',
      provider: 'persona',
      eventType: 'inquiry.created',
    });
    expect(identity.calls).toEqual([persona.nextOutcome]);
  });
});
