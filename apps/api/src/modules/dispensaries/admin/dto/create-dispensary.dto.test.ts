/**
 * Unit tests for admin dispensary write DTOs.
 *
 * Create DTO behaviours pinned here:
 *   - All required fields present → parses cleanly.
 *   - Status is NOT accepted on create (new rows always start at 'onboarding').
 *   - The DTO is `.strict()` so unknown fields are rejected (typo guard +
 *     accidental field-leak guard from a future schema widening).
 *   - License date order is enforced (expiresAt > issuedAt) at the schema.
 *   - Optional null/nullable fields round-trip correctly.
 *
 * Patch DTO behaviours pinned here:
 *   - All fields are optional.
 *   - licenseNumber and region are not in the schema at all (rejected by .strict).
 *   - Date order is enforced only when both dates appear in the same patch.
 *   - Empty objects parse OK at the schema (service rejects them — keeps the
 *     error message specific and the schema declarative).
 */
import { describe, expect, it } from 'vitest';
import {
  CreateDispensaryRequestSchema,
  PatchDispensaryRequestSchema,
} from './create-dispensary.dto.js';

const VALID_HOURS = {
  mon: { open: '09:00', close: '22:00' },
  tue: { open: '09:00', close: '22:00' },
  wed: { open: '09:00', close: '22:00' },
  thu: { open: '09:00', close: '22:00' },
  fri: { open: '09:00', close: '22:00' },
  sat: { open: '10:00', close: '22:00' },
  sun: null,
};

const VALID_POLYGON = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [-93.3, 44.9],
      [-93.2, 44.9],
      [-93.2, 45.0],
      [-93.3, 45.0],
      [-93.3, 44.9],
    ],
  ],
};

const VALID_POINT = { type: 'Point' as const, coordinates: [-93.27, 44.97] };

function makeCreateBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    legalName: 'North Star Cannabis Co.',
    licenseNumber: 'OCM-12345',
    licenseType: 'retailer',
    licenseIssuedAt: '2024-01-01',
    licenseExpiresAt: '2028-01-01',
    addressLine1: '100 Main St',
    city: 'Minneapolis',
    region: 'MN',
    postalCode: '55401',
    location: VALID_POINT,
    deliveryPolygon: VALID_POLYGON,
    hours: VALID_HOURS,
    ...overrides,
  };
}

describe('CreateDispensaryRequestSchema', () => {
  it('parses a minimal valid create body', () => {
    const parsed = CreateDispensaryRequestSchema.parse(makeCreateBody());
    expect(parsed.legalName).toBe('North Star Cannabis Co.');
    expect(parsed.licenseNumber).toBe('OCM-12345');
  });

  it('rejects an unknown top-level field (typo guard via .strict)', () => {
    expect(() =>
      CreateDispensaryRequestSchema.parse(makeCreateBody({ status: 'active' })),
    ).toThrow();
  });

  it('rejects creating with status field at all (status must come from activate)', () => {
    expect(() =>
      CreateDispensaryRequestSchema.parse(makeCreateBody({ status: 'onboarding' })),
    ).toThrow();
  });

  it('rejects a missing required field (license number)', () => {
    const body = makeCreateBody();
    delete body['licenseNumber'];
    expect(() => CreateDispensaryRequestSchema.parse(body)).toThrow();
  });

  it('rejects licenseExpiresAt <= licenseIssuedAt', () => {
    expect(() =>
      CreateDispensaryRequestSchema.parse(
        makeCreateBody({ licenseIssuedAt: '2026-05-01', licenseExpiresAt: '2026-05-01' }),
      ),
    ).toThrow();
    expect(() =>
      CreateDispensaryRequestSchema.parse(
        makeCreateBody({ licenseIssuedAt: '2026-05-02', licenseExpiresAt: '2026-05-01' }),
      ),
    ).toThrow();
  });

  it('rejects a non-2-letter region', () => {
    expect(() =>
      CreateDispensaryRequestSchema.parse(makeCreateBody({ region: 'Minnesota' })),
    ).toThrow();
  });

  it('rejects a malformed brandColorHex', () => {
    expect(() =>
      CreateDispensaryRequestSchema.parse(makeCreateBody({ brandColorHex: 'green' })),
    ).toThrow();
  });

  it('rejects a malformed ISO date in license fields', () => {
    expect(() =>
      CreateDispensaryRequestSchema.parse(makeCreateBody({ licenseIssuedAt: '01-01-2024' })),
    ).toThrow();
  });

  it('rejects a phone that looks nothing like a phone number', () => {
    expect(() =>
      CreateDispensaryRequestSchema.parse(makeCreateBody({ phone: 'call me' })),
    ).toThrow();
  });

  it('accepts optional fields as null', () => {
    const parsed = CreateDispensaryRequestSchema.parse(
      makeCreateBody({
        dba: null,
        addressLine2: null,
        metrcFacilityId: null,
        phone: null,
        email: null,
        logoImageKey: null,
        heroImageKey: null,
        brandColorHex: null,
      }),
    );
    expect(parsed.dba).toBeNull();
    expect(parsed.phone).toBeNull();
    expect(parsed.brandColorHex).toBeNull();
  });

  it('accepts a valid posProvider enum value', () => {
    const parsed = CreateDispensaryRequestSchema.parse(makeCreateBody({ posProvider: 'dutchie' }));
    expect(parsed.posProvider).toBe('dutchie');
  });

  it('rejects an unknown posProvider', () => {
    expect(() =>
      CreateDispensaryRequestSchema.parse(makeCreateBody({ posProvider: 'square' })),
    ).toThrow();
  });
});

describe('PatchDispensaryRequestSchema', () => {
  it('accepts an empty object at the schema layer (service rejects)', () => {
    expect(PatchDispensaryRequestSchema.parse({})).toEqual({});
  });

  it('rejects an unknown top-level field (typo guard via .strict)', () => {
    expect(() => PatchDispensaryRequestSchema.parse({ status: 'active' })).toThrow();
  });

  it('rejects licenseNumber on patch (corrections go through a dedicated endpoint)', () => {
    expect(() => PatchDispensaryRequestSchema.parse({ licenseNumber: 'OCM-00001' })).toThrow();
  });

  it('rejects region on patch (cross-jurisdiction moves are not a casual patch)', () => {
    expect(() => PatchDispensaryRequestSchema.parse({ region: 'WI' })).toThrow();
  });

  it('rejects location on patch (the store point moves only with an address correction)', () => {
    expect(() => PatchDispensaryRequestSchema.parse({ location: VALID_POINT })).toThrow();
  });

  it('accepts a deliveryPolygon patch (zones grow and shrink over a store life)', () => {
    const parsed = PatchDispensaryRequestSchema.parse({ deliveryPolygon: VALID_POLYGON });
    expect(parsed.deliveryPolygon).toEqual(VALID_POLYGON);
  });

  it('rejects a malformed deliveryPolygon (wrong geometry type)', () => {
    expect(() =>
      PatchDispensaryRequestSchema.parse({
        deliveryPolygon: { type: 'MultiPolygon', coordinates: VALID_POLYGON.coordinates },
      }),
    ).toThrow();
  });

  it('accepts a single field', () => {
    const parsed = PatchDispensaryRequestSchema.parse({ legalName: 'New Name LLC' });
    expect(parsed.legalName).toBe('New Name LLC');
    expect(parsed.dba).toBeUndefined();
  });

  it('accepts a partial hours patch', () => {
    const parsed = PatchDispensaryRequestSchema.parse({ hours: VALID_HOURS });
    expect(parsed.hours).toEqual(VALID_HOURS);
  });

  it('rejects licenseExpiresAt <= licenseIssuedAt when both are in the same patch', () => {
    expect(() =>
      PatchDispensaryRequestSchema.parse({
        licenseIssuedAt: '2026-05-01',
        licenseExpiresAt: '2026-05-01',
      }),
    ).toThrow();
  });

  it('defers ordering when only one date is in the patch (cross-check happens in the service)', () => {
    expect(() =>
      PatchDispensaryRequestSchema.parse({ licenseIssuedAt: '2026-05-01' }),
    ).not.toThrow();
    expect(() =>
      PatchDispensaryRequestSchema.parse({ licenseExpiresAt: '2026-05-01' }),
    ).not.toThrow();
  });

  it('accepts isAcceptingOrders toggle (the only status-shaped field patchable here)', () => {
    expect(PatchDispensaryRequestSchema.parse({ isAcceptingOrders: false })).toEqual({
      isAcceptingOrders: false,
    });
  });

  it('accepts nullable fields being explicitly nulled', () => {
    const parsed = PatchDispensaryRequestSchema.parse({
      dba: null,
      addressLine2: null,
      logoImageKey: null,
    });
    expect(parsed.dba).toBeNull();
    expect(parsed.addressLine2).toBeNull();
    expect(parsed.logoImageKey).toBeNull();
  });
});
