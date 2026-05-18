/**
 * Unit tests for IdentityController + KycWebhookController.
 *
 * Both controllers are thin pass-throughs; the meaningful logic lives in
 * IdentityService and PersonaService (covered by their own suites). What
 * we lock down here:
 *
 *   - The /me routes thread userId from the @CurrentUser claim through to
 *     the service.
 *   - The webhook controller refuses an empty body and a missing
 *     Persona-Signature header before reaching PersonaService — these are
 *     the two preconditions the controller itself enforces.
 */
import { KycError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { IdentityController } from './identity.controller.js';
import { KycWebhookController } from './kyc-webhook.controller.js';
import type { KycStartResponse, MeResponse, UpdateMeRequestDto } from './dto/index.js';
import type { IdentityService } from './identity.service.js';
import type { PersonaService, WebhookOutcome } from './persona/persona.service.js';
import type { AuthenticatedUser } from '../auth/guards/auth-types.js';
import type { RawBodyRequest } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

const USER: AuthenticatedUser = {
  userId: '01935f3d-0000-7000-8000-000000000001',
  sessionId: '01935f3d-0000-7000-8000-000000000099',
  role: 'customer',
};

const ME: MeResponse = {
  id: USER.userId,
  email: 'jane@example.com',
  phone: '+16125550100',
  firstName: 'Jane',
  lastName: 'Doe',
  role: 'customer',
  status: 'pending_kyc',
  kycVerified: false,
  kycVerifiedAt: null,
  mfaEnabled: false,
  lastLoginAt: null,
  createdAt: '2026-05-01T00:00:00.000+00:00',
};

class FakeIdentityService {
  readonly calls = {
    getMe: [] as string[],
    updateMe: [] as Array<{ userId: string; patch: UpdateMeRequestDto }>,
    startKyc: [] as string[],
    applyKycOutcome: [] as WebhookOutcome[],
  };

  getMe = (userId: string): Promise<MeResponse> => {
    this.calls.getMe.push(userId);
    return Promise.resolve(ME);
  };

  updateMe = (userId: string, patch: UpdateMeRequestDto): Promise<MeResponse> => {
    this.calls.updateMe.push({ userId, patch });
    // Spread conditionally so `firstName: undefined` from a .partial() DTO
    // doesn't override MeResponse's `string | null` shape — exactOptionalPropertyTypes
    // rejects `undefined` from a non-optional `string | null` slot.
    return Promise.resolve({
      ...ME,
      ...(patch.firstName !== undefined ? { firstName: patch.firstName } : {}),
      ...(patch.lastName !== undefined ? { lastName: patch.lastName } : {}),
    });
  };

  startKyc = (userId: string): Promise<KycStartResponse> => {
    this.calls.startKyc.push(userId);
    return Promise.resolve({
      inquiryId: 'inq_test_123',
      inquiryUrl: 'https://withpersona.com/verify?inquiry-id=inq_test_123',
    });
  };

  applyKycOutcome = (outcome: WebhookOutcome): Promise<void> => {
    this.calls.applyKycOutcome.push(outcome);
    return Promise.resolve();
  };
}

class FakePersonaService {
  readonly calls = {
    handleWebhook: [] as Array<{ raw: string; signature: string }>,
  };
  nextOutcome: WebhookOutcome = { type: 'ignored', eventName: 'inquiry.unknown' };

  handleWebhook = (raw: string, signature: string): WebhookOutcome => {
    this.calls.handleWebhook.push({ raw, signature });
    return this.nextOutcome;
  };
}

function makeWebhookRequest(
  rawBody: Buffer | undefined,
  signature: string | undefined,
): RawBodyRequest<FastifyRequest> {
  // Webhook handler reads two surfaces: rawBody and headers['persona-signature'].
  // Casting at construction keeps the route-generic FastifyRequest noise out.
  return {
    rawBody,
    headers: signature === undefined ? {} : { 'persona-signature': signature },
  } as unknown as RawBodyRequest<FastifyRequest>;
}

describe('IdentityController', () => {
  it('getMe pulls userId from the @CurrentUser claim', async () => {
    const svc = new FakeIdentityService();
    const controller = new IdentityController(svc as unknown as never);

    const res = await controller.getMe(USER);

    expect(res).toEqual(ME);
    expect(svc.calls.getMe).toEqual([USER.userId]);
  });

  it('updateMe forwards both the userId and the patch body', async () => {
    const svc = new FakeIdentityService();
    const controller = new IdentityController(svc as unknown as never);
    const patch: UpdateMeRequestDto = { firstName: 'Janet', lastName: 'Smith' };

    const res = await controller.updateMe(USER, patch);

    expect(res.firstName).toBe('Janet');
    expect(res.lastName).toBe('Smith');
    expect(svc.calls.updateMe).toEqual([{ userId: USER.userId, patch }]);
  });

  it('startKyc returns the hosted-flow URL for the iOS Safari hand-off', async () => {
    const svc = new FakeIdentityService();
    const controller = new IdentityController(svc as unknown as never);

    const res = await controller.startKyc(USER);

    expect(res.inquiryUrl).toContain('withpersona.com');
    expect(svc.calls.startKyc).toEqual([USER.userId]);
  });
});

describe('KycWebhookController', () => {
  const buildController = (): {
    controller: KycWebhookController;
    persona: FakePersonaService;
    identity: FakeIdentityService;
  } => {
    const persona = new FakePersonaService();
    const identity = new FakeIdentityService();
    const controller = new KycWebhookController(
      persona as unknown as PersonaService,
      identity as unknown as IdentityService,
    );
    return { controller, persona, identity };
  };

  it('forwards the raw body + signature to PersonaService and applies the outcome', async () => {
    const { controller, persona, identity } = buildController();
    const raw = Buffer.from(
      '{"data":{"type":"event","attributes":{"name":"inquiry.completed"}}}',
      'utf8',
    );
    persona.nextOutcome = {
      type: 'kyc.completed',
      userId: USER.userId,
      inquiryId: 'inq_test_456',
      dateOfBirth: '1990-01-15',
    };

    await controller.webhook(makeWebhookRequest(raw, 't=1700000000,v1=abcdef'));

    expect(persona.calls.handleWebhook).toEqual([
      { raw: raw.toString('utf8'), signature: 't=1700000000,v1=abcdef' },
    ]);
    expect(identity.calls.applyKycOutcome).toEqual([persona.nextOutcome]);
  });

  it('throws KYC_WEBHOOK_PAYLOAD_INVALID when raw body is missing', async () => {
    const { controller, persona } = buildController();

    await expect(
      controller.webhook(makeWebhookRequest(undefined, 't=1700000000,v1=abc')),
    ).rejects.toMatchObject({ code: 'KYC_WEBHOOK_PAYLOAD_INVALID' });
    expect(persona.calls.handleWebhook).toHaveLength(0);
  });

  it('throws KYC_WEBHOOK_PAYLOAD_INVALID when raw body is empty', async () => {
    const { controller } = buildController();

    await expect(
      controller.webhook(makeWebhookRequest(Buffer.alloc(0), 't=1700000000,v1=abc')),
    ).rejects.toBeInstanceOf(KycError);
  });

  it('throws KYC_WEBHOOK_SIGNATURE_INVALID when persona-signature header is missing', async () => {
    const { controller } = buildController();

    await expect(
      controller.webhook(makeWebhookRequest(Buffer.from('{}'), undefined)),
    ).rejects.toMatchObject({ code: 'KYC_WEBHOOK_SIGNATURE_INVALID' });
  });
});
