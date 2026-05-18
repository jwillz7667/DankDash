/**
 * Identity DTO tests. Same shape as auth/dto/dto.test.ts — schemas
 * exercised directly. The webhook DTO is intentionally permissive (the
 * authoritative parse lives in PersonaService) so we only assert it
 * accepts the envelope shape and lets unknown fields through.
 */
import { describe, expect, it } from 'vitest';
import { KycStartResponseSchema, KycWebhookEnvelopeSchema } from './kyc.dto.js';
import { MeResponseSchema, UpdateMeRequestSchema } from './me.dto.js';

describe('KycStartResponseSchema', () => {
  it('accepts an inquiry url + id', () => {
    const parsed = KycStartResponseSchema.parse({
      inquiryId: 'inq_abc123',
      inquiryUrl: 'https://withpersona.com/verify?inquiry-id=inq_abc123',
    });
    expect(parsed.inquiryId).toBe('inq_abc123');
  });

  it('rejects a non-URL inquiry URL', () => {
    expect(() =>
      KycStartResponseSchema.parse({ inquiryId: 'x', inquiryUrl: 'not a url' }),
    ).toThrow();
  });
});

describe('KycWebhookEnvelopeSchema', () => {
  it('accepts the Persona envelope shape', () => {
    expect(() =>
      KycWebhookEnvelopeSchema.parse({
        data: {
          type: 'event',
          id: 'evt_1',
          attributes: { name: 'inquiry.completed', payload: { anything: 'goes' } },
        },
      }),
    ).not.toThrow();
  });

  it('passes unknown top-level fields through (no .strict)', () => {
    expect(() =>
      KycWebhookEnvelopeSchema.parse({
        data: { type: 'event', attributes: { name: 'x', payload: {} } },
        meta: { source: 'persona' },
      }),
    ).not.toThrow();
  });

  it('rejects an envelope missing data.attributes.name', () => {
    expect(() =>
      KycWebhookEnvelopeSchema.parse({
        data: { type: 'event', attributes: { payload: {} } },
      }),
    ).toThrow();
  });
});

describe('MeResponseSchema', () => {
  const sample = {
    id: '01906c93-7ad0-7c5e-be19-9a8e0f37c4f8',
    email: 'jane@example.com',
    phone: '+14155551234',
    firstName: 'Jane',
    lastName: 'Doe',
    role: 'customer',
    status: 'active',
    kycVerified: true,
    kycVerifiedAt: '2026-05-01T12:00:00.000Z',
    mfaEnabled: false,
    lastLoginAt: '2026-05-17T08:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  } as const;

  it('accepts a complete me response', () => {
    expect(() => MeResponseSchema.parse(sample)).not.toThrow();
  });

  it('accepts null lastLoginAt and kycVerifiedAt', () => {
    expect(() =>
      MeResponseSchema.parse({ ...sample, lastLoginAt: null, kycVerifiedAt: null }),
    ).not.toThrow();
  });

  it('rejects unknown fields', () => {
    expect(() => MeResponseSchema.parse({ ...sample, ssn: '123' })).toThrow();
  });
});

describe('UpdateMeRequestSchema', () => {
  it('accepts a partial patch with just firstName', () => {
    const parsed = UpdateMeRequestSchema.parse({ firstName: 'Janet' });
    expect(parsed.firstName).toBe('Janet');
  });

  it('accepts both firstName and lastName', () => {
    expect(() =>
      UpdateMeRequestSchema.parse({ firstName: 'Janet', lastName: 'Smith' }),
    ).not.toThrow();
  });

  it('rejects an empty patch (must change something)', () => {
    expect(() => UpdateMeRequestSchema.parse({})).toThrow(/at least one field/u);
  });

  it('rejects attempts to change protected fields like email', () => {
    expect(() => UpdateMeRequestSchema.parse({ email: 'new@example.com' })).toThrow();
  });

  it('rejects attempts to change role', () => {
    expect(() => UpdateMeRequestSchema.parse({ role: 'admin' })).toThrow();
  });
});
