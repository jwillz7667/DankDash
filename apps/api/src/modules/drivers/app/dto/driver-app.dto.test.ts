/**
 * Boundary-validation tests for the driver-app DTOs. Asserts the wire
 * shape against the bits a controller can't catch on its own — period
 * defaulting, .strict() enforcement, the dropoff/pickup nesting, and
 * the explicit ISO datetime + UUID + integer shapes.
 */
import { describe, expect, it } from 'vitest';
import {
  CurrentRouteResponseSchema,
  DropoffSchema,
  EarningsPeriodSchema,
  EarningsQuerySchema,
  EarningsResponseSchema,
  PickupSchema,
  ShiftsListResponseSchema,
} from './driver-app.dto.js';

const VALID_PICKUP = {
  dispensaryId: '01935f3d-0000-7000-8000-0000000000a1',
  name: 'Northside Cannabis Co',
  addressLine1: '100 W 1st St',
  addressLine2: null,
  city: 'Minneapolis',
  region: 'MN',
  postalCode: '55401',
  location: { type: 'Point' as const, coordinates: [-93.265, 44.977] as const },
  phone: '+16125551212',
  brandColorHex: '#1F8A3C',
};

const VALID_DROPOFF = {
  id: '01935f3d-0000-7000-8000-0000000000b1',
  label: 'Home',
  line1: '500 S 5th St',
  line2: 'Apt 3B',
  city: 'Minneapolis',
  region: 'MN',
  postalCode: '55415',
  country: 'US',
  location: { type: 'Point' as const, coordinates: [-93.262, 44.974] as const },
  deliveryInstructions: 'Leave at the door',
};

const VALID_ORDER = {
  id: '01935f3d-0000-7000-8000-000000000001',
  shortCode: 'A1B2C3',
  userId: '01935f3d-0000-7000-8000-0000000000c1',
  dispensaryId: '01935f3d-0000-7000-8000-0000000000a1',
  driverId: '01935f3d-0000-7000-8000-0000000000d1',
  status: 'en_route_pickup' as const,
  statusChangedAt: '2026-05-19T14:30:00.000Z',
  subtotalCents: 5000,
  cannabisTaxCents: 500,
  salesTaxCents: 250,
  deliveryFeeCents: 800,
  driverTipCents: 500,
  discountCents: 0,
  totalCents: 7050,
  timestamps: {
    placedAt: '2026-05-19T14:00:00.000Z',
    paymentFailedAt: null,
    acceptedAt: '2026-05-19T14:05:00.000Z',
    rejectedAt: null,
    preppingAt: '2026-05-19T14:06:00.000Z',
    preparedAt: '2026-05-19T14:20:00.000Z',
    awaitingDriverAt: '2026-05-19T14:21:00.000Z',
    dispatchFailedAt: null,
    driverAssignedAt: '2026-05-19T14:25:00.000Z',
    enRoutePickupAt: '2026-05-19T14:26:00.000Z',
    pickedUpAt: null,
    enRouteDropoffAt: null,
    arrivedAtDropoffAt: null,
    idScanPendingAt: null,
    deliveredAt: null,
    returnedToStoreAt: null,
    canceledAt: null,
    disputedAt: null,
    ratedAt: null,
  },
  ratings: { customer: null, review: null, dispensary: null, driver: null },
};

describe('EarningsPeriodSchema', () => {
  it('exposes exactly the three periods the service handles', () => {
    expect(EarningsPeriodSchema.options).toEqual(['today', 'week', 'month']);
  });
});

describe('EarningsQuerySchema', () => {
  it('defaults missing period to today', () => {
    const res = EarningsQuerySchema.safeParse({});
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.period).toBe('today');
  });

  it('accepts an explicit period', () => {
    const res = EarningsQuerySchema.safeParse({ period: 'week' });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.period).toBe('week');
  });

  it('rejects an unknown period', () => {
    expect(EarningsQuerySchema.safeParse({ period: 'year' }).success).toBe(false);
  });

  it('rejects extra keys (.strict)', () => {
    expect(EarningsQuerySchema.safeParse({ period: 'today', extra: 1 }).success).toBe(false);
  });
});

describe('EarningsResponseSchema', () => {
  const VALID: ReturnType<(typeof EarningsResponseSchema)['parse']> = {
    period: 'today',
    since: '2026-05-19T05:00:00.000Z',
    until: '2026-05-20T05:00:00.000Z',
    tipsCents: 1500,
    deliveryFeesCents: 4000,
    deliveriesCount: 5,
    totalCents: 5500,
  };

  it('accepts a well-formed response', () => {
    expect(EarningsResponseSchema.safeParse(VALID).success).toBe(true);
  });

  it('rejects negative cents', () => {
    expect(EarningsResponseSchema.safeParse({ ...VALID, tipsCents: -1 }).success).toBe(false);
  });

  it('rejects fractional cents', () => {
    expect(EarningsResponseSchema.safeParse({ ...VALID, tipsCents: 12.5 }).success).toBe(false);
  });

  it('rejects extra keys (.strict)', () => {
    expect(EarningsResponseSchema.safeParse({ ...VALID, extra: 1 }).success).toBe(false);
  });

  it('rejects a non-ISO since timestamp', () => {
    expect(
      EarningsResponseSchema.safeParse({ ...VALID, since: '2026-05-19 05:00:00' }).success,
    ).toBe(false);
  });
});

describe('PickupSchema', () => {
  it('accepts a well-formed pickup', () => {
    expect(PickupSchema.safeParse(VALID_PICKUP).success).toBe(true);
  });

  it('allows null phone and brandColorHex', () => {
    expect(
      PickupSchema.safeParse({ ...VALID_PICKUP, phone: null, brandColorHex: null }).success,
    ).toBe(true);
  });

  it('rejects extra keys (.strict)', () => {
    expect(PickupSchema.safeParse({ ...VALID_PICKUP, extra: 1 }).success).toBe(false);
  });

  it('rejects a non-Point location', () => {
    const res = PickupSchema.safeParse({
      ...VALID_PICKUP,
      location: { type: 'Polygon', coordinates: [[]] },
    });
    expect(res.success).toBe(false);
  });
});

describe('DropoffSchema', () => {
  it('accepts a well-formed dropoff', () => {
    expect(DropoffSchema.safeParse(VALID_DROPOFF).success).toBe(true);
  });

  it('accepts a dropoff with null location (legacy pre-geocoding row)', () => {
    expect(DropoffSchema.safeParse({ ...VALID_DROPOFF, location: null }).success).toBe(true);
  });

  it('rejects extra keys (.strict)', () => {
    expect(DropoffSchema.safeParse({ ...VALID_DROPOFF, extra: 1 }).success).toBe(false);
  });

  it('rejects missing required city/region/postalCode', () => {
    const { city: _city, ...withoutCity } = VALID_DROPOFF;
    expect(DropoffSchema.safeParse(withoutCity).success).toBe(false);
  });
});

describe('CurrentRouteResponseSchema', () => {
  it('accepts activeOrder = null', () => {
    expect(CurrentRouteResponseSchema.safeParse({ activeOrder: null }).success).toBe(true);
  });

  it('accepts a fully populated active route', () => {
    const res = CurrentRouteResponseSchema.safeParse({
      activeOrder: { order: VALID_ORDER, pickup: VALID_PICKUP, dropoff: VALID_DROPOFF },
    });
    expect(res.success).toBe(true);
  });

  it('rejects extra keys at the top level (.strict)', () => {
    const res = CurrentRouteResponseSchema.safeParse({ activeOrder: null, extra: 1 });
    expect(res.success).toBe(false);
  });

  it('rejects extra keys inside activeOrder (.strict)', () => {
    const res = CurrentRouteResponseSchema.safeParse({
      activeOrder: { order: VALID_ORDER, pickup: VALID_PICKUP, dropoff: VALID_DROPOFF, extra: 1 },
    });
    expect(res.success).toBe(false);
  });
});

describe('ShiftsListResponseSchema', () => {
  const VALID_SHIFT = {
    id: '01935f3d-0000-7000-8000-0000000000f1',
    driverId: '01935f3d-0000-7000-8000-0000000000d1',
    startedAt: '2026-05-19T12:00:00.000Z',
    endedAt: null,
    startingLocation: { type: 'Point' as const, coordinates: [-93.265, 44.977] as const },
    endingLocation: null,
    totalMiles: null,
    totalDeliveries: 0,
    totalEarningsCents: 0,
  };

  it('accepts an empty array', () => {
    expect(ShiftsListResponseSchema.safeParse({ shifts: [] }).success).toBe(true);
  });

  it('accepts a list with one open shift', () => {
    expect(ShiftsListResponseSchema.safeParse({ shifts: [VALID_SHIFT] }).success).toBe(true);
  });

  it('rejects extra keys (.strict)', () => {
    expect(ShiftsListResponseSchema.safeParse({ shifts: [], extra: 1 }).success).toBe(false);
  });
});
