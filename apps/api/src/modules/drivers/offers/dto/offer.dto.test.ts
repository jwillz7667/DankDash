/**
 * Boundary-validation tests for the offer DTOs. These guard the bits a
 * controller will not catch on its own — overlong reasons, empty-string
 * reasons (post-trim), extra keys (`.strict()` enforcement), and the
 * status enum staying in lockstep with the DB `offer_status`.
 */
import { describe, expect, it } from 'vitest';
import {
  DeclineOfferRequestSchema,
  DispatchOfferResponseSchema,
  DispatchOfferStatusSchema,
} from './offer.dto.js';

const VALID_RESPONSE = {
  id: '01935f3d-0000-7000-8000-0000000000e1',
  orderId: '01935f3d-0000-7000-8000-000000000001',
  driverId: '01935f3d-0000-7000-8000-0000000000d1',
  offeredAt: '2026-05-19T14:30:00.000Z',
  expiresAt: '2026-05-19T14:30:25.000Z',
  payoutEstimateCents: 1200,
  distanceMiles: '2.50',
  status: 'offered' as const,
  respondedAt: null,
  declineReason: null,
};

describe('DeclineOfferRequestSchema', () => {
  it('accepts an empty body (decline without a reason)', () => {
    expect(DeclineOfferRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a well-formed reason', () => {
    expect(DeclineOfferRequestSchema.safeParse({ reason: 'too far' }).success).toBe(true);
  });

  it('trims whitespace before length checks', () => {
    const res = DeclineOfferRequestSchema.safeParse({ reason: '  too far  ' });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.reason).toBe('too far');
  });

  it('rejects an empty / whitespace-only reason after trim', () => {
    expect(DeclineOfferRequestSchema.safeParse({ reason: '' }).success).toBe(false);
    expect(DeclineOfferRequestSchema.safeParse({ reason: '   ' }).success).toBe(false);
  });

  it('rejects a reason over 280 chars', () => {
    expect(DeclineOfferRequestSchema.safeParse({ reason: 'a'.repeat(281) }).success).toBe(false);
  });

  it('accepts a reason at exactly 280 chars', () => {
    expect(DeclineOfferRequestSchema.safeParse({ reason: 'a'.repeat(280) }).success).toBe(true);
  });

  it('rejects extra keys (.strict)', () => {
    const res = DeclineOfferRequestSchema.safeParse({ reason: 'too far', extra: 1 });
    expect(res.success).toBe(false);
  });
});

describe('DispatchOfferStatusSchema', () => {
  // Pinned: the wire enum is the same shape as the column enum. If a new
  // status is added to the DB, this test forces an explicit update here.
  it('exposes exactly the four statuses the DB enum carries', () => {
    expect(DispatchOfferStatusSchema.options).toEqual([
      'offered',
      'accepted',
      'declined',
      'expired',
    ]);
  });
});

describe('DispatchOfferResponseSchema', () => {
  it('accepts a well-formed response', () => {
    expect(DispatchOfferResponseSchema.safeParse(VALID_RESPONSE).success).toBe(true);
  });

  it('accepts a responded offer with declineReason', () => {
    const responded = {
      ...VALID_RESPONSE,
      status: 'declined' as const,
      respondedAt: '2026-05-19T14:30:05.000Z',
      declineReason: 'too far',
    };
    expect(DispatchOfferResponseSchema.safeParse(responded).success).toBe(true);
  });

  it('rejects extra keys (.strict)', () => {
    const res = DispatchOfferResponseSchema.safeParse({ ...VALID_RESPONSE, extra: 1 });
    expect(res.success).toBe(false);
  });

  it('rejects negative payoutEstimateCents', () => {
    const res = DispatchOfferResponseSchema.safeParse({
      ...VALID_RESPONSE,
      payoutEstimateCents: -1,
    });
    expect(res.success).toBe(false);
  });

  it('rejects fractional payoutEstimateCents', () => {
    const res = DispatchOfferResponseSchema.safeParse({
      ...VALID_RESPONSE,
      payoutEstimateCents: 12.5,
    });
    expect(res.success).toBe(false);
  });

  it('rejects a non-ISO timestamp', () => {
    const res = DispatchOfferResponseSchema.safeParse({
      ...VALID_RESPONSE,
      offeredAt: '2026-05-19 14:30:00',
    });
    expect(res.success).toBe(false);
  });

  it('rejects a non-UUID id', () => {
    const res = DispatchOfferResponseSchema.safeParse({ ...VALID_RESPONSE, id: 'not-a-uuid' });
    expect(res.success).toBe(false);
  });
});
