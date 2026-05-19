/**
 * Boundary-validation tests for the shift DTOs. These guard the bits a
 * controller will not catch on its own — out-of-range coordinates,
 * disallowed self-set statuses, and extra-keys (`.strict()` enforcement).
 */
import { describe, expect, it } from 'vitest';
import {
  EndShiftRequestSchema,
  SelfSettableDriverStatusSchema,
  StartShiftRequestSchema,
  UpdateDriverStatusRequestSchema,
} from './shift.dto.js';

const VALID_POINT = { type: 'Point' as const, coordinates: [-93.265, 44.977] as const };

describe('StartShiftRequestSchema', () => {
  it('accepts a well-formed GeoJSON Point inside lat/lng range', () => {
    expect(StartShiftRequestSchema.safeParse({ startingLocation: VALID_POINT }).success).toBe(true);
  });

  it('rejects extra keys (.strict)', () => {
    const res = StartShiftRequestSchema.safeParse({
      startingLocation: VALID_POINT,
      extra: 1,
    });
    expect(res.success).toBe(false);
  });

  it('rejects an out-of-range latitude', () => {
    const res = StartShiftRequestSchema.safeParse({
      startingLocation: { type: 'Point' as const, coordinates: [-93.265, 95] as const },
    });
    expect(res.success).toBe(false);
  });

  it('rejects an out-of-range longitude', () => {
    const res = StartShiftRequestSchema.safeParse({
      startingLocation: { type: 'Point' as const, coordinates: [-200, 44.977] as const },
    });
    expect(res.success).toBe(false);
  });

  it('rejects a non-Point geometry shape', () => {
    const res = StartShiftRequestSchema.safeParse({
      startingLocation: { type: 'Polygon', coordinates: [[[-93, 44]]] },
    });
    expect(res.success).toBe(false);
  });
});

describe('EndShiftRequestSchema', () => {
  it('accepts an ending location', () => {
    expect(EndShiftRequestSchema.safeParse({ endingLocation: VALID_POINT }).success).toBe(true);
  });

  it('rejects a missing endingLocation', () => {
    expect(EndShiftRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('UpdateDriverStatusRequestSchema', () => {
  it.each(['online', 'on_break', 'unavailable'] as const)('accepts %s', (status) => {
    expect(UpdateDriverStatusRequestSchema.safeParse({ status }).success).toBe(true);
  });

  // Catches the case "someone added en_route_pickup to driverStatus and
  // forgot to update SelfSettableDriverStatusSchema". The wire enum is
  // the same shape as the column enum minus the lifecycle-only states.
  it.each(['offline', 'en_route_pickup', 'en_route_dropoff'] as const)('rejects %s', (status) => {
    expect(UpdateDriverStatusRequestSchema.safeParse({ status }).success).toBe(false);
  });

  it('rejects extra keys', () => {
    const res = UpdateDriverStatusRequestSchema.safeParse({ status: 'online', extra: 1 });
    expect(res.success).toBe(false);
  });
});

describe('SelfSettableDriverStatusSchema', () => {
  it('exposes the same options the request schema admits', () => {
    expect(SelfSettableDriverStatusSchema.options).toEqual(['online', 'on_break', 'unavailable']);
  });
});
