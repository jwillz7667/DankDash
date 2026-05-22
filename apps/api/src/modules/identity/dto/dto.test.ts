/**
 * Identity DTO tests. Same shape as auth/dto/dto.test.ts — schemas
 * exercised directly. The webhook DTO is intentionally permissive (the
 * authoritative parse lives in PersonaService) so we only assert it
 * accepts the envelope shape and lets unknown fields through.
 */
import { describe, expect, it } from 'vitest';
import {
  DispensaryMembershipSchema,
  DispensaryMembershipsResponseSchema,
} from './dispensaries.dto.js';
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

describe('DispensaryMembershipSchema', () => {
  const sample = {
    id: '01906c93-7ad0-7c5e-be19-9a8e0f37c4f8',
    displayName: 'North Loop',
    staffRole: 'manager' as const,
    acceptedAt: '2026-04-02T00:00:00.000Z',
    joinedAt: '2026-04-02T00:00:00.000Z',
  };

  it('accepts a fully-populated membership', () => {
    expect(() => DispensaryMembershipSchema.parse(sample)).not.toThrow();
  });

  it('accepts a pending-invite membership with null acceptedAt', () => {
    expect(() => DispensaryMembershipSchema.parse({ ...sample, acceptedAt: null })).not.toThrow();
  });

  it('rejects a non-UUID dispensary id', () => {
    expect(() => DispensaryMembershipSchema.parse({ ...sample, id: 'not-a-uuid' })).toThrow();
  });

  it('rejects an unknown staff role', () => {
    expect(() => DispensaryMembershipSchema.parse({ ...sample, staffRole: 'janitor' })).toThrow();
  });

  it('rejects an empty displayName', () => {
    expect(() => DispensaryMembershipSchema.parse({ ...sample, displayName: '' })).toThrow();
  });

  it('rejects unknown fields', () => {
    expect(() => DispensaryMembershipSchema.parse({ ...sample, secret: 'x' })).toThrow();
  });
});

describe('DispensaryMembershipsResponseSchema', () => {
  it('accepts an empty memberships array', () => {
    expect(() => DispensaryMembershipsResponseSchema.parse({ memberships: [] })).not.toThrow();
  });

  it('accepts multiple memberships', () => {
    const sample = {
      memberships: [
        {
          id: '01906c93-7ad0-7c5e-be19-9a8e0f37c4f8',
          displayName: 'A',
          staffRole: 'owner' as const,
          acceptedAt: '2026-04-02T00:00:00.000Z',
          joinedAt: '2026-04-02T00:00:00.000Z',
        },
        {
          id: '01906c93-7ad0-7c5e-be19-9a8e0f37c4f9',
          displayName: 'B',
          staffRole: 'budtender' as const,
          acceptedAt: null,
          joinedAt: '2026-04-15T00:00:00.000Z',
        },
      ],
    };
    expect(() => DispensaryMembershipsResponseSchema.parse(sample)).not.toThrow();
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
