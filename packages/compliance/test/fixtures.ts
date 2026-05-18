/**
 * Shared test fixtures and builders. Centralized so a change to the
 * default-pass cart, default user, or default dispensary updates every
 * test at once.
 */
import { Decimal } from 'decimal.js';
import type {
  CartLine,
  DispensaryHours,
  EvaluationContext,
  EvaluationDispensary,
  EvaluationLocation,
  EvaluationUser,
  ProductType,
} from '../src/index.js';
import type { Polygon } from 'geojson';

/**
 * A small rectangular polygon around downtown Minneapolis (≈ Hennepin Ave
 * to St. Anthony Falls). Big enough to contain MPLS_POINT comfortably and
 * small enough that any out-of-state coordinate is clearly outside.
 */
export const MPLS_POLYGON: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-93.3, 44.95],
      [-93.23, 44.95],
      [-93.23, 45.0],
      [-93.3, 45.0],
      [-93.3, 44.95],
    ],
  ],
};

export const MPLS_POINT: EvaluationLocation = { latitude: 44.977, longitude: -93.265 };

/** Out-of-state coordinates for the interstate-fail tests. */
export const HUDSON_WI: EvaluationLocation = { latitude: 44.974, longitude: -92.756 };
export const FARGO_ND: EvaluationLocation = { latitude: 46.877, longitude: -96.789 };
export const SIOUX_FALLS_SD: EvaluationLocation = { latitude: 43.546, longitude: -96.731 };
export const DES_MOINES_IA: EvaluationLocation = { latitude: 41.587, longitude: -93.625 };

export const LICENSE_EXPIRES_FAR_FUTURE = new Date('2099-01-01T00:00:00Z');

export const ALWAYS_OPEN_HOURS: DispensaryHours = {
  mon: { open: '08:00', close: '26:00' },
  tue: { open: '08:00', close: '26:00' },
  wed: { open: '08:00', close: '26:00' },
  thu: { open: '08:00', close: '26:00' },
  fri: { open: '08:00', close: '26:00' },
  sat: { open: '08:00', close: '26:00' },
  sun: { open: '08:00', close: '26:00' },
};

/** A weekday at 12:00 noon in America/Chicago — comfortably mid-day. */
export const MIDDAY_2026_MAY_18: Date = new Date('2026-05-18T17:00:00Z');

export function makeUser(overrides: Partial<EvaluationUser> = {}): EvaluationUser {
  return {
    id: '01935f3d-0000-7000-8000-000000000001',
    dateOfBirth: new Date('1990-01-15T00:00:00Z'),
    kycVerifiedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function makeDispensary(
  overrides: Partial<EvaluationDispensary> = {},
): EvaluationDispensary {
  return {
    id: '01935f3d-0000-7000-8000-000000000010',
    licenseExpiresAt: LICENSE_EXPIRES_FAR_FUTURE,
    hoursJson: ALWAYS_OPEN_HOURS,
    deliveryPolygon: MPLS_POLYGON,
    timezone: 'America/Chicago',
    ...overrides,
  };
}

/**
 * A cart line at zero weight / zero potency by default. Override the
 * relevant fields per test. `id` is generated so two lines in the same
 * cart get distinct ids without the caller having to think about it.
 */
let lineCounter = 0;
export function makeCartLine(
  overrides: Partial<CartLine> & { productType: ProductType },
): CartLine {
  lineCounter += 1;
  return {
    id: `line-${lineCounter.toString().padStart(4, '0')}`,
    quantity: 1,
    weightGramsPerUnit: new Decimal(0),
    thcMgPerUnit: new Decimal(0),
    thcMgPerServing: null,
    servingCount: null,
    ...overrides,
  };
}

export function makeContext(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    user: makeUser(),
    dispensary: makeDispensary(),
    deliveryLocation: MPLS_POINT,
    cart: [],
    now: MIDDAY_2026_MAY_18,
    ...overrides,
  };
}
