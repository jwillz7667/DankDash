/**
 * Dispensaries DTO tests. Schemas are exercised directly; the Nest pipeline
 * is covered in common/pipes/zod-validation.pipe.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  DayHoursSchema,
  DispensaryHoursSchema,
  DispensaryListResponseSchema,
  DispensaryResponseSchema,
  GeoPointSchema,
  GeoPolygonSchema,
  LicenseTypeSchema,
} from './dispensary.dto.js';
import { ListDispensariesQuerySchema } from './list-dispensaries.dto.js';
import { MenuItemResponseSchema, MenuProductSchema, MenuResponseSchema } from './menu.dto.js';

describe('GeoPointSchema', () => {
  it('accepts a valid GeoJSON point', () => {
    expect(() =>
      GeoPointSchema.parse({ type: 'Point', coordinates: [-93.27, 44.97] }),
    ).not.toThrow();
  });

  it('rejects a polygon shape', () => {
    expect(() => GeoPointSchema.parse({ type: 'Polygon', coordinates: [-93.27, 44.97] })).toThrow();
  });

  it('rejects coordinates that are not a pair', () => {
    expect(() => GeoPointSchema.parse({ type: 'Point', coordinates: [-93.27] })).toThrow();
    expect(() =>
      GeoPointSchema.parse({ type: 'Point', coordinates: [-93.27, 44.97, 0] }),
    ).toThrow();
  });
});

describe('GeoPolygonSchema', () => {
  it('accepts a polygon with a single closed ring', () => {
    expect(() =>
      GeoPolygonSchema.parse({
        type: 'Polygon',
        coordinates: [
          [
            [-93.3, 44.9],
            [-93.2, 44.9],
            [-93.2, 45.0],
            [-93.3, 45.0],
            [-93.3, 44.9],
          ],
        ],
      }),
    ).not.toThrow();
  });

  it('rejects a point shape', () => {
    expect(() => GeoPolygonSchema.parse({ type: 'Point', coordinates: [-93.27, 44.97] })).toThrow();
  });
});

describe('DayHoursSchema', () => {
  it.each(['09:00', '00:00', '23:59', '26:00', '02:30'])('accepts %s as a valid time', (t) => {
    expect(() => DayHoursSchema.parse({ open: t, close: t })).not.toThrow();
  });

  it.each(['24:60', '31:00', '9am', '09:0', ''])('rejects %s as malformed', (t) => {
    expect(() => DayHoursSchema.parse({ open: t, close: '12:00' })).toThrow();
  });

  it('accepts the single-digit hour shorthand `9:00` (engine-compatible)', () => {
    // The shared hours engine in @dankdash/dispensaries parses `\d{1,2}:\d{2}`,
    // so the DTO must accept the same set or it would 400 valid persisted data.
    expect(() => DayHoursSchema.parse({ open: '9:00', close: '17:00' })).not.toThrow();
  });

  it('rejects unknown keys (strict)', () => {
    expect(() =>
      DayHoursSchema.parse({ open: '09:00', close: '17:00', breakStart: '12:00' }),
    ).toThrow();
  });
});

describe('DispensaryHoursSchema', () => {
  it('accepts a full week with every day populated', () => {
    const day = { open: '10:00', close: '22:00' };
    expect(() =>
      DispensaryHoursSchema.parse({
        mon: day,
        tue: day,
        wed: day,
        thu: day,
        fri: day,
        sat: day,
        sun: day,
      }),
    ).not.toThrow();
  });

  it('accepts null for closed days', () => {
    expect(() =>
      DispensaryHoursSchema.parse({
        mon: { open: '10:00', close: '22:00' },
        tue: { open: '10:00', close: '22:00' },
        wed: { open: '10:00', close: '22:00' },
        thu: { open: '10:00', close: '22:00' },
        fri: { open: '10:00', close: '22:00' },
        sat: { open: '10:00', close: '22:00' },
        sun: null,
      }),
    ).not.toThrow();
  });

  it('rejects a missing weekday', () => {
    expect(() =>
      DispensaryHoursSchema.parse({
        mon: { open: '10:00', close: '22:00' },
        // tue intentionally missing
        wed: { open: '10:00', close: '22:00' },
        thu: { open: '10:00', close: '22:00' },
        fri: { open: '10:00', close: '22:00' },
        sat: { open: '10:00', close: '22:00' },
        sun: { open: '10:00', close: '22:00' },
      }),
    ).toThrow();
  });
});

describe('LicenseTypeSchema', () => {
  it('accepts every license_type enum value', () => {
    for (const t of [
      'retailer',
      'microbusiness',
      'mezzobusiness',
      'medical_combo',
      'delivery_service',
      'lphe_retailer',
    ]) {
      expect(() => LicenseTypeSchema.parse(t)).not.toThrow();
    }
  });

  it('rejects an unknown license type', () => {
    expect(() => LicenseTypeSchema.parse('grow_only')).toThrow();
  });
});

describe('DispensaryResponseSchema', () => {
  const sample = {
    id: '01935f3d-0000-7000-8000-000000000001',
    legalName: 'North Star Cannabis Co.',
    dba: 'North Star',
    licenseNumber: 'OCM-12345',
    licenseType: 'retailer',
    addressLine1: '100 Main St',
    addressLine2: null,
    city: 'Minneapolis',
    region: 'MN',
    postalCode: '55401',
    location: { type: 'Point', coordinates: [-93.27, 44.97] },
    deliveryPolygon: {
      type: 'Polygon',
      coordinates: [
        [
          [-93.3, 44.9],
          [-93.2, 44.9],
          [-93.2, 45.0],
          [-93.3, 45.0],
          [-93.3, 44.9],
        ],
      ],
    },
    hours: {
      mon: { open: '10:00', close: '22:00' },
      tue: { open: '10:00', close: '22:00' },
      wed: { open: '10:00', close: '22:00' },
      thu: { open: '10:00', close: '22:00' },
      fri: { open: '10:00', close: '22:00' },
      sat: { open: '10:00', close: '22:00' },
      sun: null,
    },
    phone: '+16125551234',
    email: 'orders@northstar.example',
    logoImageKey: 'logos/north-star.png',
    heroImageKey: 'heroes/north-star.png',
    brandColorHex: '#0E5E2A',
    isAcceptingOrders: true,
    isOpenNow: true,
    opensAt: null,
    ratingAvg: '4.87',
    ratingCount: 421,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  } as const;

  it('accepts a complete dispensary', () => {
    expect(() => DispensaryResponseSchema.parse(sample)).not.toThrow();
  });

  it('accepts nullables (dba, address2, contact, brand, rating, opensAt)', () => {
    expect(() =>
      DispensaryResponseSchema.parse({
        ...sample,
        dba: null,
        addressLine2: null,
        phone: null,
        email: null,
        logoImageKey: null,
        heroImageKey: null,
        brandColorHex: null,
        ratingAvg: null,
        opensAt: null,
      }),
    ).not.toThrow();
  });

  it('accepts a populated opensAt for closed dispensaries', () => {
    expect(() =>
      DispensaryResponseSchema.parse({
        ...sample,
        isOpenNow: false,
        opensAt: '2026-05-18T15:00:00.000Z',
      }),
    ).not.toThrow();
  });

  it('rejects an unknown field (strict mode preserves the response contract)', () => {
    expect(() =>
      DispensaryResponseSchema.parse({ ...sample, internalNotes: 'do-not-leak' }),
    ).toThrow();
  });

  it('rejects internal columns leaking through (metrcApiKeyEnc, deletedAt, posCredentialsEnc)', () => {
    expect(() =>
      DispensaryResponseSchema.parse({ ...sample, metrcApiKeyEnc: new Uint8Array() }),
    ).toThrow();
    expect(() => DispensaryResponseSchema.parse({ ...sample, deletedAt: null })).toThrow();
    expect(() =>
      DispensaryResponseSchema.parse({ ...sample, posCredentialsEnc: new Uint8Array() }),
    ).toThrow();
  });

  it('rejects a non-uuid id', () => {
    expect(() => DispensaryResponseSchema.parse({ ...sample, id: 'not-a-uuid' })).toThrow();
  });

  it('rejects a negative ratingCount', () => {
    expect(() => DispensaryResponseSchema.parse({ ...sample, ratingCount: -1 })).toThrow();
  });
});

describe('DispensaryListResponseSchema', () => {
  it('accepts an empty list', () => {
    expect(() => DispensaryListResponseSchema.parse({ dispensaries: [] })).not.toThrow();
  });

  it('rejects unknown top-level fields', () => {
    expect(() => DispensaryListResponseSchema.parse({ dispensaries: [], cursor: 'x' })).toThrow();
  });
});

describe('ListDispensariesQuerySchema', () => {
  it('accepts an empty query', () => {
    const parsed = ListDispensariesQuerySchema.parse({});
    expect(parsed.lat).toBeUndefined();
    expect(parsed.lng).toBeUndefined();
  });

  it('coerces lat/lng from query strings to numbers', () => {
    const parsed = ListDispensariesQuerySchema.parse({ lat: '44.97', lng: '-93.27' });
    expect(parsed.lat).toBe(44.97);
    expect(parsed.lng).toBe(-93.27);
  });

  it('rejects lat alone (must be paired with lng)', () => {
    expect(() => ListDispensariesQuerySchema.parse({ lat: '44.97' })).toThrow();
  });

  it('rejects lng alone (must be paired with lat)', () => {
    expect(() => ListDispensariesQuerySchema.parse({ lng: '-93.27' })).toThrow();
  });

  it('rejects lat outside [-90, 90]', () => {
    expect(() => ListDispensariesQuerySchema.parse({ lat: '91', lng: '0' })).toThrow();
    expect(() => ListDispensariesQuerySchema.parse({ lat: '-91', lng: '0' })).toThrow();
  });

  it('rejects lng outside [-180, 180]', () => {
    expect(() => ListDispensariesQuerySchema.parse({ lat: '0', lng: '181' })).toThrow();
    expect(() => ListDispensariesQuerySchema.parse({ lat: '0', lng: '-181' })).toThrow();
  });

  it('rejects unknown keys (strict)', () => {
    expect(() => ListDispensariesQuerySchema.parse({ q: 'flower' })).toThrow();
  });
});

describe('MenuProductSchema', () => {
  const sample = {
    id: '01935f3d-0000-7000-8000-000000000001',
    categoryId: '01935f3d-0000-7000-8000-0000000000a1',
    brand: 'Sunny Side',
    name: 'Sour Tangie 3.5g',
    description: null,
    productType: 'flower',
    strainType: 'sativa',
    thcMgPerUnit: '24.500',
    cbdMgPerUnit: '0.100',
    weightGramsPerUnit: '3.500',
    servingCount: null,
    thcMgPerServing: null,
    imageKeys: ['products/sunny-side/sour-tangie/01.jpg'],
    effectsTags: ['uplifting'],
    flavorTags: ['citrus'],
  } as const;

  it('accepts a complete menu product', () => {
    expect(() => MenuProductSchema.parse(sample)).not.toThrow();
  });

  it('rejects createdAt / updatedAt / labResults (those belong on /products/:id)', () => {
    expect(() =>
      MenuProductSchema.parse({ ...sample, createdAt: '2026-05-01T00:00:00.000Z' }),
    ).toThrow();
    expect(() => MenuProductSchema.parse({ ...sample, labResults: [] })).toThrow();
  });
});

describe('MenuItemResponseSchema', () => {
  const product = {
    id: '01935f3d-0000-7000-8000-000000000001',
    categoryId: '01935f3d-0000-7000-8000-0000000000a1',
    brand: 'Sunny Side',
    name: 'Sour Tangie 3.5g',
    description: null,
    productType: 'flower' as const,
    strainType: 'sativa' as const,
    thcMgPerUnit: '24.500',
    cbdMgPerUnit: '0.100',
    weightGramsPerUnit: '3.500',
    servingCount: null,
    thcMgPerServing: null,
    imageKeys: [] as const,
    effectsTags: [] as const,
    flavorTags: [] as const,
  };
  const sample = {
    listingId: '01935f3d-0000-7000-8000-0000000000c1',
    sku: 'NS-SOUR-3.5',
    priceCents: 4500,
    compareAtPriceCents: 5000,
    quantityAvailable: 12,
    product,
  } as const;

  it('accepts a complete menu line', () => {
    expect(() => MenuItemResponseSchema.parse(sample)).not.toThrow();
  });

  it('accepts a null compareAtPriceCents', () => {
    expect(() =>
      MenuItemResponseSchema.parse({ ...sample, compareAtPriceCents: null }),
    ).not.toThrow();
  });

  it('rejects a non-positive priceCents (must be > 0)', () => {
    expect(() => MenuItemResponseSchema.parse({ ...sample, priceCents: 0 })).toThrow();
    expect(() => MenuItemResponseSchema.parse({ ...sample, priceCents: -100 })).toThrow();
  });

  it('rejects a negative quantityAvailable', () => {
    expect(() => MenuItemResponseSchema.parse({ ...sample, quantityAvailable: -1 })).toThrow();
  });

  it('accepts zero quantityAvailable (allows a dispensary to show out-of-stock SKUs)', () => {
    expect(() => MenuItemResponseSchema.parse({ ...sample, quantityAvailable: 0 })).not.toThrow();
  });
});

describe('MenuResponseSchema', () => {
  it('accepts an empty menu', () => {
    expect(() =>
      MenuResponseSchema.parse({
        dispensaryId: '01935f3d-0000-7000-8000-000000000001',
        items: [],
      }),
    ).not.toThrow();
  });

  it('rejects unknown top-level fields', () => {
    expect(() =>
      MenuResponseSchema.parse({
        dispensaryId: '01935f3d-0000-7000-8000-000000000001',
        items: [],
        version: 1,
      }),
    ).toThrow();
  });
});
