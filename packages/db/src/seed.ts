import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { type Logger } from 'pino';
import { type Database } from './client.js';
import { type GeoPoint, type GeoPolygon } from './schema/custom-types.js';
import {
  type IdDocumentType,
  type LicenseType,
  type PaymentMethodStatus,
  type PaymentMethodType,
  type PosProvider,
  type ProductType,
  type StaffRole,
  type StrainType,
  type UserRole,
  type UserStatus,
} from './schema/enums.js';
import { pointToSql, polygonToSql } from './schema/geo.js';
import * as schema from './schema/index.js';

/**
 * Deterministic seed for development and integration tests. Re-running against
 * a fresh database produces byte-identical rows because every UUID, hash, and
 * timestamp is derived from the {@link SEED_NAMESPACE} constant. The seed
 * truncates every table in dependency order before reinserting, so it is
 * SAFE TO RERUN BUT DESTRUCTIVE — never run against a database holding real
 * customer data.
 */

const SEED_NAMESPACE = 'dankdash-seed-v1';

/**
 * Sentinel password-hash format. The auth module (Phase 2) rejects any hash
 * starting with `$seed$` so that nobody can authenticate as a seeded account.
 * Re-seeding after auth ships will overwrite these with real argon2id hashes.
 */
const SEED_PASSWORD_HASH = '$seed$placeholder-not-bcrypt-do-not-use-in-prod';

/**
 * Stable, deterministic UUID v5 generated from `${namespace}|${category}|${key}`.
 * The version (5) and variant (RFC 4122) bits are set explicitly so the
 * output satisfies the `uuid` column type in Postgres. NOT time-ordered like
 * UUIDv7 — runtime inserts use {@link newId} for that property.
 */
export function stableUuid(category: string, key: string | number): string {
  const hash = createHash('sha1')
    .update(`${SEED_NAMESPACE}|${category}|${String(key)}`)
    .digest();
  // Version 5 in the high nibble of byte 6.
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  // Variant RFC 4122 in the high two bits of byte 8.
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Stable hash byte string for `bytea` columns that hold non-reversible
 * derivations (driver's-license-number hashes, etc). 32 bytes wide.
 */
function stableHash(category: string, key: string | number): Uint8Array {
  return new Uint8Array(
    createHash('sha256')
      .update(`${SEED_NAMESPACE}|${category}|${String(key)}`)
      .digest(),
  );
}

// All seeded timestamps anchor to this instant so seed runs are byte-identical
// regardless of wall-clock time at run.
const ANCHOR = new Date('2026-01-15T12:00:00.000Z');
const days = (n: number): Date => new Date(ANCHOR.getTime() + n * 86_400_000);

// ---------------------------------------------------------------------------
// Users (5 customers + 3 drivers + 6 staff = 14 total)
// ---------------------------------------------------------------------------

interface SeedUser {
  readonly key: string;
  readonly email: string;
  readonly phone: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly firstName: string;
  readonly lastName: string;
  readonly dateOfBirth: string;
  readonly kycVerifiedAt: Date | null;
}

const CUSTOMERS: readonly SeedUser[] = [
  {
    key: 'customer-1',
    email: 'alice.kim@example.com',
    phone: '+16125550101',
    role: 'customer',
    status: 'active',
    firstName: 'Alice',
    lastName: 'Kim',
    dateOfBirth: '1992-03-14',
    kycVerifiedAt: days(-30),
  },
  {
    key: 'customer-2',
    email: 'ben.olson@example.com',
    phone: '+16125550102',
    role: 'customer',
    status: 'pending_kyc',
    firstName: 'Ben',
    lastName: 'Olson',
    dateOfBirth: '1988-11-02',
    kycVerifiedAt: null,
  },
  {
    key: 'customer-3',
    email: 'cara.nguyen@example.com',
    phone: '+16125550103',
    role: 'customer',
    status: 'banned',
    firstName: 'Cara',
    lastName: 'Nguyen',
    dateOfBirth: '1995-07-22',
    kycVerifiedAt: days(-90),
  },
  {
    key: 'customer-4',
    email: 'derek.lopez@example.com',
    phone: '+16125550104',
    role: 'customer',
    status: 'active',
    firstName: 'Derek',
    lastName: 'Lopez',
    dateOfBirth: '1985-01-30',
    kycVerifiedAt: days(-60),
  },
  {
    key: 'customer-5',
    email: 'erin.patel@example.com',
    phone: '+16125550105',
    role: 'customer',
    status: 'active',
    firstName: 'Erin',
    lastName: 'Patel',
    dateOfBirth: '1999-05-12',
    kycVerifiedAt: days(-7),
  },
];

const DRIVER_USERS: readonly SeedUser[] = [
  {
    key: 'driver-1',
    email: 'frank.dasher@example.com',
    phone: '+16125550201',
    role: 'driver',
    status: 'active',
    firstName: 'Frank',
    lastName: 'Brennan',
    dateOfBirth: '1990-09-09',
    kycVerifiedAt: days(-120),
  },
  {
    key: 'driver-2',
    email: 'gina.dasher@example.com',
    phone: '+16125550202',
    role: 'driver',
    status: 'active',
    firstName: 'Gina',
    lastName: 'Holm',
    dateOfBirth: '1987-06-18',
    kycVerifiedAt: days(-200),
  },
  {
    key: 'driver-3',
    email: 'hector.dasher@example.com',
    phone: '+16125550203',
    role: 'driver',
    status: 'active',
    firstName: 'Hector',
    lastName: 'Sanchez',
    dateOfBirth: '1993-12-01',
    kycVerifiedAt: days(-45),
  },
];

interface SeedStaff {
  readonly userKey: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly dispensaryKey: string;
  readonly role: StaffRole;
}

const STAFF: readonly SeedStaff[] = [
  {
    userKey: 'staff-mpls-owner',
    email: 'iris.mpls@example.com',
    firstName: 'Iris',
    lastName: 'Anderson',
    dispensaryKey: 'mpls',
    role: 'owner',
  },
  {
    userKey: 'staff-mpls-bud',
    email: 'jake.mpls@example.com',
    firstName: 'Jake',
    lastName: 'Larson',
    dispensaryKey: 'mpls',
    role: 'budtender',
  },
  {
    userKey: 'staff-stp-owner',
    email: 'kate.stp@example.com',
    firstName: 'Kate',
    lastName: 'Hernandez',
    dispensaryKey: 'stp',
    role: 'owner',
  },
  {
    userKey: 'staff-stp-mgr',
    email: 'leo.stp@example.com',
    firstName: 'Leo',
    lastName: 'Reyes',
    dispensaryKey: 'stp',
    role: 'manager',
  },
  {
    userKey: 'staff-mg-owner',
    email: 'mia.mg@example.com',
    firstName: 'Mia',
    lastName: 'Schmidt',
    dispensaryKey: 'mg',
    role: 'owner',
  },
  {
    userKey: 'staff-mg-bud',
    email: 'noah.mg@example.com',
    firstName: 'Noah',
    lastName: 'Carlson',
    dispensaryKey: 'mg',
    role: 'budtender',
  },
];

// ---------------------------------------------------------------------------
// Dispensaries — three Twin Cities locations with realistic delivery polygons.
// ---------------------------------------------------------------------------

interface SeedDispensary {
  readonly key: string;
  readonly legalName: string;
  readonly dba: string;
  readonly licenseNumber: string;
  readonly licenseType: LicenseType;
  readonly addressLine1: string;
  readonly city: string;
  readonly postalCode: string;
  readonly phone: string;
  readonly email: string;
  readonly posProvider: PosProvider;
  readonly location: GeoPoint;
  readonly deliveryPolygon: GeoPolygon;
  // numeric(3,2) — passed through as a string so Drizzle doesn't lose precision.
  readonly ratingAvg: string;
  readonly ratingCount: number;
}

// Keys must be the 3-letter lowercase weekday codes the @dankdash/dispensaries
// `DispensaryHours` type defines. Anything else round-trips through `isOpenAt`
// as `undefined` and explodes when the service projects `isOpenNow`.
// Full statutory window (Minn. Stat. § 342.27 subd. (d): 8:00 AM–2:00 AM).
// A close earlier than the open is the cross-midnight encoding the
// @dankdash/dispensaries hours engine documents (08:00–02:00 ≡ 08:00–26:00).
// Declared hours this wide let dev/demo test orders run at any hour the
// state allows; the compliance engine still clamps to the statutory cap,
// so the 2 AM–8 AM dead zone remains closed.
const HOURS_JSON = {
  mon: { open: '08:00', close: '02:00' },
  tue: { open: '08:00', close: '02:00' },
  wed: { open: '08:00', close: '02:00' },
  thu: { open: '08:00', close: '02:00' },
  fri: { open: '08:00', close: '02:00' },
  sat: { open: '08:00', close: '02:00' },
  sun: { open: '08:00', close: '02:00' },
} as const;

const DISPENSARIES: readonly SeedDispensary[] = [
  {
    key: 'mpls',
    legalName: 'North Loop Cannabis Co. LLC',
    dba: 'North Loop Cannabis',
    licenseNumber: 'MN-RTL-001-2025',
    licenseType: 'retailer',
    addressLine1: '720 N Washington Ave',
    city: 'Minneapolis',
    postalCode: '55401',
    phone: '+16125558501',
    email: 'hello@northloopcannabis.example.com',
    posProvider: 'dutchie',
    ratingAvg: '4.80',
    ratingCount: 214,
    location: { type: 'Point', coordinates: [-93.273, 44.987] },
    deliveryPolygon: {
      type: 'Polygon',
      coordinates: [
        [
          [-93.33, 44.88],
          [-93.33, 45.06],
          [-93.18, 45.06],
          [-93.18, 44.88],
          [-93.33, 44.88],
        ],
      ],
    },
  },
  {
    key: 'stp',
    legalName: 'Capitol Cannabis Group LLC',
    dba: 'Capitol Cannabis',
    licenseNumber: 'MN-RTL-002-2025',
    licenseType: 'retailer',
    addressLine1: '350 N Robert St',
    city: 'St. Paul',
    postalCode: '55101',
    phone: '+16515558502',
    email: 'hello@capitolcannabis.example.com',
    posProvider: 'flowhub',
    ratingAvg: '4.60',
    ratingCount: 156,
    location: { type: 'Point', coordinates: [-93.09, 44.954] },
    deliveryPolygon: {
      type: 'Polygon',
      coordinates: [
        [
          [-93.18, 44.88],
          [-93.18, 45.03],
          [-93.02, 45.03],
          [-93.02, 44.88],
          [-93.18, 44.88],
        ],
      ],
    },
  },
  {
    key: 'mg',
    legalName: 'Grove Microcannabis LLC',
    dba: 'The Grove',
    licenseNumber: 'MN-MIC-003-2025',
    licenseType: 'microbusiness',
    addressLine1: '12805 Elm Creek Blvd',
    city: 'Maple Grove',
    postalCode: '55369',
    phone: '+17635558503',
    email: 'hello@grovecannabis.example.com',
    posProvider: 'treez',
    ratingAvg: '4.70',
    ratingCount: 89,
    location: { type: 'Point', coordinates: [-93.456, 45.073] },
    deliveryPolygon: {
      type: 'Polygon',
      coordinates: [
        [
          [-93.52, 45.02],
          [-93.52, 45.15],
          [-93.38, 45.15],
          [-93.38, 45.02],
          [-93.52, 45.02],
        ],
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// User addresses — one per active customer, each inside MPLS polygon for tests.
// ---------------------------------------------------------------------------

interface SeedAddress {
  readonly key: string;
  readonly userKey: string;
  readonly label: string;
  readonly line1: string;
  readonly city: string;
  readonly postalCode: string;
  readonly location: GeoPoint;
}

const ADDRESSES: readonly SeedAddress[] = [
  {
    key: 'addr-alice-home',
    userKey: 'customer-1',
    label: 'Home',
    line1: '1010 Hennepin Ave Apt 312',
    city: 'Minneapolis',
    postalCode: '55403',
    location: { type: 'Point', coordinates: [-93.276, 44.974] },
  },
  {
    key: 'addr-derek-home',
    userKey: 'customer-4',
    label: 'Home',
    line1: '525 Selby Ave',
    city: 'St. Paul',
    postalCode: '55102',
    location: { type: 'Point', coordinates: [-93.12, 44.943] },
  },
  {
    key: 'addr-erin-home',
    userKey: 'customer-5',
    label: 'Home',
    line1: '14200 Weaver Lake Rd',
    city: 'Maple Grove',
    postalCode: '55369',
    location: { type: 'Point', coordinates: [-93.46, 45.095] },
  },
];

// ---------------------------------------------------------------------------
// Product categories
// ---------------------------------------------------------------------------

interface SeedCategory {
  readonly key: string;
  readonly slug: string;
  readonly displayName: string;
  readonly displayOrder: number;
}

const CATEGORIES: readonly SeedCategory[] = [
  { key: 'cat-flower', slug: 'flower', displayName: 'Flower', displayOrder: 1 },
  { key: 'cat-preroll', slug: 'pre-rolls', displayName: 'Pre-Rolls', displayOrder: 2 },
  { key: 'cat-vape', slug: 'vape', displayName: 'Vapes & Cartridges', displayOrder: 3 },
  { key: 'cat-edible', slug: 'edibles', displayName: 'Edibles', displayOrder: 4 },
  { key: 'cat-beverage', slug: 'beverages', displayName: 'Beverages', displayOrder: 5 },
  { key: 'cat-concentrate', slug: 'concentrates', displayName: 'Concentrates', displayOrder: 6 },
  { key: 'cat-tincture', slug: 'tinctures', displayName: 'Tinctures', displayOrder: 7 },
  { key: 'cat-topical', slug: 'topicals', displayName: 'Topicals & Wellness', displayOrder: 8 },
  { key: 'cat-accessory', slug: 'accessories', displayName: 'Accessories', displayOrder: 9 },
];

// ---------------------------------------------------------------------------
// Products — 40 SKUs across categories with realistic MN-compliant potency.
// ---------------------------------------------------------------------------

interface SeedProduct {
  readonly key: string;
  readonly categoryKey: string;
  readonly brand: string;
  readonly name: string;
  readonly description: string;
  readonly productType: ProductType;
  readonly strainType: StrainType | null;
  readonly thcMgPerUnit: string;
  readonly cbdMgPerUnit: string;
  readonly weightGramsPerUnit: string;
  readonly servingCount: number | null;
  readonly thcMgPerServing: string | null;
  readonly effectsTags: readonly string[];
  readonly flavorTags: readonly string[];
}

const PRODUCTS: readonly SeedProduct[] = [
  // Flower (8)
  {
    key: 'p-flower-bg-1',
    categoryKey: 'cat-flower',
    brand: 'Boreal Gold',
    name: 'Sunset Sherbet 3.5g',
    description: 'Indica-leaning hybrid with sweet, fruity notes.',
    productType: 'flower',
    strainType: 'hybrid',
    thcMgPerUnit: '787.500',
    cbdMgPerUnit: '7.000',
    weightGramsPerUnit: '3.500',
    servingCount: null,
    thcMgPerServing: null,
    effectsTags: ['relaxed', 'happy', 'creative'],
    flavorTags: ['berry', 'citrus', 'vanilla'],
  },
  {
    key: 'p-flower-bg-2',
    categoryKey: 'cat-flower',
    brand: 'Boreal Gold',
    name: 'Northern Lights 7g',
    description: 'Classic indica, calming and earthy.',
    productType: 'flower',
    strainType: 'indica',
    thcMgPerUnit: '1505.000',
    cbdMgPerUnit: '14.000',
    weightGramsPerUnit: '7.000',
    servingCount: null,
    thcMgPerServing: null,
    effectsTags: ['relaxed', 'sleepy'],
    flavorTags: ['earthy', 'pine'],
  },
  {
    key: 'p-flower-prl-1',
    categoryKey: 'cat-flower',
    brand: 'Prairie Leaf',
    name: 'Durban Poison 3.5g',
    description: 'Pure sativa with energizing citrus notes.',
    productType: 'flower',
    strainType: 'sativa',
    thcMgPerUnit: '840.000',
    cbdMgPerUnit: '3.500',
    weightGramsPerUnit: '3.500',
    servingCount: null,
    thcMgPerServing: null,
    effectsTags: ['energetic', 'focused', 'uplifted'],
    flavorTags: ['citrus', 'sweet'],
  },
  {
    key: 'p-flower-prl-2',
    categoryKey: 'cat-flower',
    brand: 'Prairie Leaf',
    name: 'Blue Dream 14g',
    description: 'Balanced hybrid, smooth and fruity.',
    productType: 'flower',
    strainType: 'hybrid',
    thcMgPerUnit: '2870.000',
    cbdMgPerUnit: '28.000',
    weightGramsPerUnit: '14.000',
    servingCount: null,
    thcMgPerServing: null,
    effectsTags: ['relaxed', 'creative'],
    flavorTags: ['blueberry', 'sweet'],
  },
  {
    key: 'p-flower-tt-1',
    categoryKey: 'cat-flower',
    brand: 'Twin Terps',
    name: 'Wedding Cake 3.5g',
    description: 'Indica-dominant hybrid with vanilla finish.',
    productType: 'flower',
    strainType: 'hybrid',
    thcMgPerUnit: '910.000',
    cbdMgPerUnit: '3.500',
    weightGramsPerUnit: '3.500',
    servingCount: null,
    thcMgPerServing: null,
    effectsTags: ['relaxed', 'euphoric'],
    flavorTags: ['vanilla', 'earthy'],
  },
  {
    key: 'p-flower-tt-2',
    categoryKey: 'cat-flower',
    brand: 'Twin Terps',
    name: 'Sour Diesel 3.5g',
    description: 'Energizing sativa, pungent diesel aroma.',
    productType: 'flower',
    strainType: 'sativa',
    thcMgPerUnit: '770.000',
    cbdMgPerUnit: '7.000',
    weightGramsPerUnit: '3.500',
    servingCount: null,
    thcMgPerServing: null,
    effectsTags: ['energetic', 'happy'],
    flavorTags: ['diesel', 'citrus'],
  },
  {
    key: 'p-flower-cb-1',
    categoryKey: 'cat-flower',
    brand: 'Calm Botanics',
    name: 'ACDC 3.5g (CBD)',
    description: 'High-CBD strain with minimal psychoactive effect.',
    productType: 'flower',
    strainType: 'cbd',
    thcMgPerUnit: '21.000',
    cbdMgPerUnit: '525.000',
    weightGramsPerUnit: '3.500',
    servingCount: null,
    thcMgPerServing: null,
    effectsTags: ['relaxed', 'focused'],
    flavorTags: ['earthy', 'pine'],
  },
  {
    key: 'p-flower-cb-2',
    categoryKey: 'cat-flower',
    brand: 'Calm Botanics',
    name: 'Harlequin 7g (Balanced)',
    description: '5:2 CBD:THC balanced strain.',
    productType: 'flower',
    strainType: 'balanced',
    thcMgPerUnit: '210.000',
    cbdMgPerUnit: '525.000',
    weightGramsPerUnit: '7.000',
    servingCount: null,
    thcMgPerServing: null,
    effectsTags: ['relaxed', 'clear-headed'],
    flavorTags: ['woody', 'sweet'],
  },
  // Pre-rolls (4) and infused pre-rolls (3)
  {
    key: 'p-preroll-bg-1',
    categoryKey: 'cat-preroll',
    brand: 'Boreal Gold',
    name: 'Northern Lights Pre-Roll 1g',
    description: 'Single 1g classic indica pre-roll.',
    productType: 'preroll',
    strainType: 'indica',
    thcMgPerUnit: '215.000',
    cbdMgPerUnit: '2.000',
    weightGramsPerUnit: '1.000',
    servingCount: null,
    thcMgPerServing: null,
    effectsTags: ['relaxed', 'sleepy'],
    flavorTags: ['earthy'],
  },
  {
    key: 'p-preroll-prl-1',
    categoryKey: 'cat-preroll',
    brand: 'Prairie Leaf',
    name: 'Durban Poison 5-Pack',
    description: 'Five 0.5g sativa pre-rolls.',
    productType: 'preroll',
    strainType: 'sativa',
    thcMgPerUnit: '600.000',
    cbdMgPerUnit: '2.500',
    weightGramsPerUnit: '2.500',
    servingCount: null,
    thcMgPerServing: null,
    effectsTags: ['energetic'],
    flavorTags: ['citrus'],
  },
  {
    key: 'p-preroll-tt-1',
    categoryKey: 'cat-preroll',
    brand: 'Twin Terps',
    name: 'Wedding Cake Pre-Roll 1g',
    description: 'Single 1g hybrid pre-roll.',
    productType: 'preroll',
    strainType: 'hybrid',
    thcMgPerUnit: '260.000',
    cbdMgPerUnit: '1.000',
    weightGramsPerUnit: '1.000',
    servingCount: null,
    thcMgPerServing: null,
    effectsTags: ['relaxed', 'euphoric'],
    flavorTags: ['vanilla'],
  },
  {
    key: 'p-preroll-cb-1',
    categoryKey: 'cat-preroll',
    brand: 'Calm Botanics',
    name: 'ACDC Pre-Roll 1g (CBD)',
    description: 'CBD-dominant 1g pre-roll.',
    productType: 'preroll',
    strainType: 'cbd',
    thcMgPerUnit: '6.000',
    cbdMgPerUnit: '150.000',
    weightGramsPerUnit: '1.000',
    servingCount: null,
    thcMgPerServing: null,
    effectsTags: ['relaxed'],
    flavorTags: ['pine'],
  },
  {
    key: 'p-infused-tt-1',
    categoryKey: 'cat-preroll',
    brand: 'Twin Terps',
    name: 'Diamond-Infused Sour D 1g',
    description: 'Sativa pre-roll infused with THCa diamonds.',
    productType: 'infused_preroll',
    strainType: 'sativa',
    thcMgPerUnit: '380.000',
    cbdMgPerUnit: '1.000',
    weightGramsPerUnit: '1.000',
    servingCount: null,
    thcMgPerServing: null,
    effectsTags: ['energetic', 'euphoric'],
    flavorTags: ['diesel'],
  },
  {
    key: 'p-infused-bg-1',
    categoryKey: 'cat-preroll',
    brand: 'Boreal Gold',
    name: 'Live-Resin Sherbet 0.5g',
    description: 'Hybrid pre-roll infused with live resin.',
    productType: 'infused_preroll',
    strainType: 'hybrid',
    thcMgPerUnit: '185.000',
    cbdMgPerUnit: '0.500',
    weightGramsPerUnit: '0.500',
    servingCount: null,
    thcMgPerServing: null,
    effectsTags: ['relaxed', 'euphoric'],
    flavorTags: ['berry'],
  },
  {
    key: 'p-infused-prl-1',
    categoryKey: 'cat-preroll',
    brand: 'Prairie Leaf',
    name: 'Kief-Coated Blue Dream 1g',
    description: 'Hybrid pre-roll dusted in kief.',
    productType: 'infused_preroll',
    strainType: 'hybrid',
    thcMgPerUnit: '330.000',
    cbdMgPerUnit: '2.000',
    weightGramsPerUnit: '1.000',
    servingCount: null,
    thcMgPerServing: null,
    effectsTags: ['relaxed', 'creative'],
    flavorTags: ['blueberry'],
  },
  // Vape (5)
  {
    key: 'p-vape-bg-1',
    categoryKey: 'cat-vape',
    brand: 'Boreal Gold',
    name: 'Sherbet Live Resin Cart 0.5g',
    description: '510-thread live resin cartridge.',
    productType: 'vape',
    strainType: 'hybrid',
    thcMgPerUnit: '425.000',
    cbdMgPerUnit: '5.000',
    weightGramsPerUnit: '0.500',
    servingCount: null,
    thcMgPerServing: null,
    effectsTags: ['relaxed', 'happy'],
    flavorTags: ['berry'],
  },
  {
    key: 'p-vape-prl-1',
    categoryKey: 'cat-vape',
    brand: 'Prairie Leaf',
    name: 'Durban Distillate Cart 1g',
    description: 'High-potency distillate cartridge.',
    productType: 'vape',
    strainType: 'sativa',
    thcMgPerUnit: '870.000',
    cbdMgPerUnit: '5.000',
    weightGramsPerUnit: '1.000',
    servingCount: null,
    thcMgPerServing: null,
    effectsTags: ['energetic'],
    flavorTags: ['citrus'],
  },
  {
    key: 'p-vape-tt-1',
    categoryKey: 'cat-vape',
    brand: 'Twin Terps',
    name: 'Wedding Cake Pod 0.5g',
    description: 'All-in-one disposable pod.',
    productType: 'vape',
    strainType: 'hybrid',
    thcMgPerUnit: '430.000',
    cbdMgPerUnit: '2.000',
    weightGramsPerUnit: '0.500',
    servingCount: null,
    thcMgPerServing: null,
    effectsTags: ['relaxed'],
    flavorTags: ['vanilla'],
  },
  {
    key: 'p-vape-tt-2',
    categoryKey: 'cat-vape',
    brand: 'Twin Terps',
    name: 'Sour Diesel Cart 1g',
    description: 'Full-spectrum sativa cartridge.',
    productType: 'vape',
    strainType: 'sativa',
    thcMgPerUnit: '830.000',
    cbdMgPerUnit: '8.000',
    weightGramsPerUnit: '1.000',
    servingCount: null,
    thcMgPerServing: null,
    effectsTags: ['energetic', 'focused'],
    flavorTags: ['diesel'],
  },
  {
    key: 'p-vape-cb-1',
    categoryKey: 'cat-vape',
    brand: 'Calm Botanics',
    name: 'ACDC CBD Disposable 0.5g',
    description: 'CBD-dominant disposable vape.',
    productType: 'vape',
    strainType: 'cbd',
    thcMgPerUnit: '20.000',
    cbdMgPerUnit: '410.000',
    weightGramsPerUnit: '0.500',
    servingCount: null,
    thcMgPerServing: null,
    effectsTags: ['relaxed', 'clear-headed'],
    flavorTags: ['pine'],
  },
  // Edibles (6)
  {
    key: 'p-edible-mg-1',
    categoryKey: 'cat-edible',
    brand: 'Mill City Gummies',
    name: 'Strawberry Gummies 10pk',
    description: '10 gummies × 5mg THC each.',
    productType: 'edible',
    strainType: 'hybrid',
    thcMgPerUnit: '50.000',
    cbdMgPerUnit: '0.000',
    weightGramsPerUnit: '50.000',
    servingCount: 10,
    thcMgPerServing: '5.000',
    effectsTags: ['relaxed', 'happy'],
    flavorTags: ['strawberry'],
  },
  {
    key: 'p-edible-mg-2',
    categoryKey: 'cat-edible',
    brand: 'Mill City Gummies',
    name: 'Watermelon Gummies 10pk',
    description: '10 gummies × 5mg THC.',
    productType: 'edible',
    strainType: 'sativa',
    thcMgPerUnit: '50.000',
    cbdMgPerUnit: '0.000',
    weightGramsPerUnit: '50.000',
    servingCount: 10,
    thcMgPerServing: '5.000',
    effectsTags: ['uplifted'],
    flavorTags: ['watermelon'],
  },
  {
    key: 'p-edible-nl-1',
    categoryKey: 'cat-edible',
    brand: 'North Lake Edibles',
    name: 'Dark Chocolate Bar 100mg',
    description: '10 squares × 10mg THC.',
    productType: 'edible',
    strainType: 'indica',
    thcMgPerUnit: '100.000',
    cbdMgPerUnit: '0.000',
    weightGramsPerUnit: '40.000',
    servingCount: 10,
    thcMgPerServing: '10.000',
    effectsTags: ['relaxed', 'sleepy'],
    flavorTags: ['chocolate'],
  },
  {
    key: 'p-edible-nl-2',
    categoryKey: 'cat-edible',
    brand: 'North Lake Edibles',
    name: 'Caramel Chews 20pk',
    description: '20 chews × 2.5mg THC.',
    productType: 'edible',
    strainType: 'hybrid',
    thcMgPerUnit: '50.000',
    cbdMgPerUnit: '0.000',
    weightGramsPerUnit: '100.000',
    servingCount: 20,
    thcMgPerServing: '2.500',
    effectsTags: ['relaxed'],
    flavorTags: ['caramel'],
  },
  {
    key: 'p-edible-cb-1',
    categoryKey: 'cat-edible',
    brand: 'Calm Botanics',
    name: 'CBD Mints 20pk',
    description: '20 mints × 10mg CBD, 1mg THC.',
    productType: 'edible',
    strainType: 'cbd',
    thcMgPerUnit: '20.000',
    cbdMgPerUnit: '200.000',
    weightGramsPerUnit: '30.000',
    servingCount: 20,
    thcMgPerServing: '1.000',
    effectsTags: ['relaxed', 'clear-headed'],
    flavorTags: ['mint'],
  },
  {
    key: 'p-edible-mg-3',
    categoryKey: 'cat-edible',
    brand: 'Mill City Gummies',
    name: 'Sour Blueberry Gummies 20pk',
    description: '20 gummies × 5mg THC.',
    productType: 'edible',
    strainType: 'hybrid',
    thcMgPerUnit: '100.000',
    cbdMgPerUnit: '0.000',
    weightGramsPerUnit: '100.000',
    servingCount: 20,
    thcMgPerServing: '5.000',
    effectsTags: ['relaxed', 'happy'],
    flavorTags: ['blueberry'],
  },
  // Beverages (3) — MN cap: ≤10mg THC/serving, ≤2 servings/container.
  {
    key: 'p-bev-rs-1',
    categoryKey: 'cat-beverage',
    brand: 'River Springs',
    name: 'Hibiscus Seltzer 12oz',
    description: 'Single-serve 5mg THC seltzer.',
    productType: 'beverage',
    strainType: 'sativa',
    thcMgPerUnit: '5.000',
    cbdMgPerUnit: '0.000',
    weightGramsPerUnit: '0.000',
    servingCount: 1,
    thcMgPerServing: '5.000',
    effectsTags: ['uplifted'],
    flavorTags: ['hibiscus'],
  },
  {
    key: 'p-bev-rs-2',
    categoryKey: 'cat-beverage',
    brand: 'River Springs',
    name: 'Citrus Sparkler 12oz',
    description: 'Single-serve 10mg THC sparkling drink.',
    productType: 'beverage',
    strainType: 'hybrid',
    thcMgPerUnit: '10.000',
    cbdMgPerUnit: '0.000',
    weightGramsPerUnit: '0.000',
    servingCount: 1,
    thcMgPerServing: '10.000',
    effectsTags: ['relaxed', 'uplifted'],
    flavorTags: ['citrus'],
  },
  {
    key: 'p-bev-cb-1',
    categoryKey: 'cat-beverage',
    brand: 'Calm Botanics',
    name: 'CBD + 2mg THC Tonic 8oz',
    description: 'Single-serve micro-dose tonic.',
    productType: 'beverage',
    strainType: 'cbd',
    thcMgPerUnit: '2.000',
    cbdMgPerUnit: '20.000',
    weightGramsPerUnit: '0.000',
    servingCount: 1,
    thcMgPerServing: '2.000',
    effectsTags: ['relaxed', 'clear-headed'],
    flavorTags: ['herbal'],
  },
  // Concentrates (4)
  {
    key: 'p-conc-tt-1',
    categoryKey: 'cat-concentrate',
    brand: 'Twin Terps',
    name: 'Live Rosin 1g',
    description: 'Solventless live rosin.',
    productType: 'concentrate',
    strainType: 'hybrid',
    thcMgPerUnit: '760.000',
    cbdMgPerUnit: '6.000',
    weightGramsPerUnit: '1.000',
    servingCount: null,
    thcMgPerServing: null,
    effectsTags: ['euphoric'],
    flavorTags: ['floral'],
  },
  {
    key: 'p-conc-bg-1',
    categoryKey: 'cat-concentrate',
    brand: 'Boreal Gold',
    name: 'Shatter 1g',
    description: 'BHO shatter, classic potency.',
    productType: 'concentrate',
    strainType: 'indica',
    thcMgPerUnit: '820.000',
    cbdMgPerUnit: '3.000',
    weightGramsPerUnit: '1.000',
    servingCount: null,
    thcMgPerServing: null,
    effectsTags: ['relaxed', 'sleepy'],
    flavorTags: ['earthy'],
  },
  {
    key: 'p-conc-prl-1',
    categoryKey: 'cat-concentrate',
    brand: 'Prairie Leaf',
    name: 'Distillate Syringe 1g',
    description: 'Pure distillate for infusion.',
    productType: 'concentrate',
    strainType: 'hybrid',
    thcMgPerUnit: '900.000',
    cbdMgPerUnit: '1.000',
    weightGramsPerUnit: '1.000',
    servingCount: null,
    thcMgPerServing: null,
    effectsTags: ['euphoric'],
    flavorTags: ['neutral'],
  },
  {
    key: 'p-conc-tt-2',
    categoryKey: 'cat-concentrate',
    brand: 'Twin Terps',
    name: 'Sugar Wax 1g',
    description: 'Terpene-rich sugar consistency.',
    productType: 'concentrate',
    strainType: 'sativa',
    thcMgPerUnit: '780.000',
    cbdMgPerUnit: '5.000',
    weightGramsPerUnit: '1.000',
    servingCount: null,
    thcMgPerServing: null,
    effectsTags: ['energetic'],
    flavorTags: ['citrus'],
  },
  // Tinctures (3)
  {
    key: 'p-tinc-cb-1',
    categoryKey: 'cat-tincture',
    brand: 'Calm Botanics',
    name: 'CBD Tincture 1000mg',
    description: '30ml CBD tincture.',
    productType: 'tincture',
    strainType: 'cbd',
    thcMgPerUnit: '20.000',
    cbdMgPerUnit: '1000.000',
    weightGramsPerUnit: '30.000',
    servingCount: 30,
    thcMgPerServing: '0.667',
    effectsTags: ['relaxed'],
    flavorTags: ['herbal'],
  },
  {
    key: 'p-tinc-cb-2',
    categoryKey: 'cat-tincture',
    brand: 'Calm Botanics',
    name: '1:1 Tincture 500mg',
    description: 'Balanced THC:CBD tincture, 30ml.',
    productType: 'tincture',
    strainType: 'balanced',
    thcMgPerUnit: '250.000',
    cbdMgPerUnit: '250.000',
    weightGramsPerUnit: '30.000',
    servingCount: 30,
    thcMgPerServing: '8.333',
    effectsTags: ['relaxed', 'clear-headed'],
    flavorTags: ['mint'],
  },
  {
    key: 'p-tinc-nl-1',
    categoryKey: 'cat-tincture',
    brand: 'North Lake Edibles',
    name: 'Sleep Tincture 300mg',
    description: 'Indica-leaning blend with CBN.',
    productType: 'tincture',
    strainType: 'indica',
    thcMgPerUnit: '300.000',
    cbdMgPerUnit: '50.000',
    weightGramsPerUnit: '30.000',
    servingCount: 30,
    thcMgPerServing: '10.000',
    effectsTags: ['sleepy'],
    flavorTags: ['vanilla'],
  },
  // Topicals (2)
  {
    key: 'p-top-cb-1',
    categoryKey: 'cat-topical',
    brand: 'Calm Botanics',
    name: 'CBD Recovery Salve 2oz',
    description: 'Non-psychoactive topical salve.',
    productType: 'topical',
    strainType: 'cbd',
    thcMgPerUnit: '10.000',
    cbdMgPerUnit: '500.000',
    weightGramsPerUnit: '60.000',
    servingCount: null,
    thcMgPerServing: null,
    effectsTags: ['soothing'],
    flavorTags: ['eucalyptus'],
  },
  {
    key: 'p-top-cb-2',
    categoryKey: 'cat-topical',
    brand: 'Calm Botanics',
    name: 'THC:CBD Bath Soak 8oz',
    description: 'Bath soak with full-spectrum oil.',
    productType: 'topical',
    strainType: 'balanced',
    thcMgPerUnit: '100.000',
    cbdMgPerUnit: '100.000',
    weightGramsPerUnit: '240.000',
    servingCount: null,
    thcMgPerServing: null,
    effectsTags: ['soothing', 'relaxed'],
    flavorTags: ['lavender'],
  },
  // Accessories (2)
  {
    key: 'p-acc-1',
    categoryKey: 'cat-accessory',
    brand: 'Twin Terps',
    name: 'Borosilicate Hand Pipe',
    description: '4-inch glass pipe.',
    productType: 'accessory',
    strainType: null,
    thcMgPerUnit: '0.000',
    cbdMgPerUnit: '0.000',
    weightGramsPerUnit: '0.000',
    servingCount: null,
    thcMgPerServing: null,
    effectsTags: [],
    flavorTags: [],
  },
  {
    key: 'p-acc-2',
    categoryKey: 'cat-accessory',
    brand: 'Boreal Gold',
    name: 'Hemp Wick 5ft',
    description: 'Organic beeswax-coated hemp wick.',
    productType: 'accessory',
    strainType: null,
    thcMgPerUnit: '0.000',
    cbdMgPerUnit: '0.000',
    weightGramsPerUnit: '0.000',
    servingCount: null,
    thcMgPerServing: null,
    effectsTags: [],
    flavorTags: [],
  },
];

// ---------------------------------------------------------------------------
// Listings — every dispensary stocks a subset of products with its own price.
// ---------------------------------------------------------------------------

interface ListingPrice {
  readonly productKey: string;
  readonly priceCents: number;
  readonly quantity: number;
}

function listingsFor(
  dispensaryKey: string,
  priceMultiplier: number,
  skip: ReadonlySet<string>,
): readonly ListingPrice[] {
  return PRODUCTS.filter((product) => !skip.has(product.key)).map((product) => {
    // Deterministic price: a per-category base × multiplier × per-product hash bump.
    const base = BASE_PRICE_CENTS[product.productType];
    const hashBump = parseInt(stableHash('price', product.key).slice(0, 2).join(''), 10) % 500;
    const priceCents = Math.round((base + hashBump) * priceMultiplier);
    const quantityHash = parseInt(
      stableHash(`qty-${dispensaryKey}`, product.key).slice(0, 2).join(''),
      10,
    );
    const quantity = 20 + (quantityHash % 80); // 20..99
    return { productKey: product.key, priceCents, quantity };
  });
}

const BASE_PRICE_CENTS: Readonly<Record<ProductType, number>> = {
  flower: 4500,
  preroll: 1500,
  infused_preroll: 2800,
  vape: 5500,
  edible: 2500,
  beverage: 800,
  concentrate: 6500,
  tincture: 5000,
  topical: 4000,
  accessory: 1200,
  seed: 1500,
  clone: 2000,
};

// ---------------------------------------------------------------------------
// Payment methods — one default per active customer.
// ---------------------------------------------------------------------------

interface SeedPaymentMethod {
  readonly key: string;
  readonly userKey: string;
  readonly type: PaymentMethodType;
  readonly bankName: string;
  readonly last4: string;
  readonly status: PaymentMethodStatus;
}

const PAYMENT_METHODS: readonly SeedPaymentMethod[] = [
  {
    key: 'pm-alice',
    userKey: 'customer-1',
    type: 'aeropay_ach',
    bankName: 'Wells Fargo',
    last4: '4242',
    status: 'active',
  },
  {
    key: 'pm-derek',
    userKey: 'customer-4',
    type: 'aeropay_ach',
    bankName: 'US Bank',
    last4: '1010',
    status: 'active',
  },
  {
    key: 'pm-erin',
    userKey: 'customer-5',
    type: 'aeropay_ach',
    bankName: 'Bremer Bank',
    last4: '9999',
    status: 'active',
  },
];

// ---------------------------------------------------------------------------
// Driver records — driver_users above are the User rows; this is the Driver.
// ---------------------------------------------------------------------------

interface SeedDriverRecord {
  readonly key: string;
  readonly userKey: string;
  readonly vehicleMake: string;
  readonly vehicleModel: string;
  readonly vehicleYear: number;
  readonly vehiclePlate: string;
  readonly vehicleColor: string;
  readonly insuranceExpiresAt: string;
}

const DRIVER_RECORDS: readonly SeedDriverRecord[] = [
  {
    key: 'driver-record-1',
    userKey: 'driver-1',
    vehicleMake: 'Toyota',
    vehicleModel: 'Prius',
    vehicleYear: 2022,
    vehiclePlate: 'MN-DSH-1',
    vehicleColor: 'Silver',
    insuranceExpiresAt: '2027-01-01',
  },
  {
    key: 'driver-record-2',
    userKey: 'driver-2',
    vehicleMake: 'Honda',
    vehicleModel: 'CR-V',
    vehicleYear: 2024,
    vehiclePlate: 'MN-DSH-2',
    vehicleColor: 'Blue',
    insuranceExpiresAt: '2027-06-01',
  },
  {
    key: 'driver-record-3',
    userKey: 'driver-3',
    vehicleMake: 'Subaru',
    vehicleModel: 'Outback',
    vehicleYear: 2023,
    vehiclePlate: 'MN-DSH-3',
    vehicleColor: 'Green',
    insuranceExpiresAt: '2027-03-15',
  },
];

// ---------------------------------------------------------------------------
// User ID documents — one for the verified customers and the drivers.
// ---------------------------------------------------------------------------

interface SeedIdDocument {
  readonly key: string;
  readonly userKey: string;
  readonly type: IdDocumentType;
  readonly verified: boolean;
}

const ID_DOCUMENTS: readonly SeedIdDocument[] = [
  { key: 'id-alice', userKey: 'customer-1', type: 'drivers_license', verified: true },
  { key: 'id-derek', userKey: 'customer-4', type: 'drivers_license', verified: true },
  { key: 'id-erin', userKey: 'customer-5', type: 'state_id', verified: true },
  { key: 'id-driver-1', userKey: 'driver-1', type: 'drivers_license', verified: true },
  { key: 'id-driver-2', userKey: 'driver-2', type: 'drivers_license', verified: true },
  { key: 'id-driver-3', userKey: 'driver-3', type: 'drivers_license', verified: true },
];

// ---------------------------------------------------------------------------
// Truncation — every domain table, in dependency order, before reinsertion.
// ---------------------------------------------------------------------------

/**
 * Order matters: child tables before parents, partitioned tables included.
 * Tables that hold per-partition rows are TRUNCATEd at the parent, which
 * cascades to the partitions automatically.
 */
const TRUNCATE_TABLES: readonly string[] = [
  'audit_log',
  'webhook_events_processed',
  'notifications',
  'push_tokens',
  'notification_preferences',
  'age_verifications',
  'metrc_transactions',
  'compliance_checks',
  'dispatch_offers',
  'driver_location_history',
  'driver_shifts',
  'drivers',
  'ledger_entries',
  'refunds',
  'payouts',
  'payment_transactions',
  'payment_methods',
  'order_events',
  'order_items',
  'orders',
  'cart_items',
  'carts',
  'product_lab_results',
  'dispensary_listings',
  'products',
  'product_categories',
  'dispensary_staff',
  'dispensaries',
  'sessions',
  'user_id_documents',
  'user_addresses',
  'users',
];

export interface SeedOptions {
  readonly db: Database;
  readonly logger?: Logger;
  /** When true, TRUNCATE every domain table before insert. Defaults to true. */
  readonly truncate?: boolean;
}

export interface SeedSummary {
  readonly users: number;
  readonly dispensaries: number;
  readonly products: number;
  readonly listings: number;
  readonly staff: number;
  readonly drivers: number;
  readonly addresses: number;
  readonly paymentMethods: number;
  readonly idDocuments: number;
}

/**
 * Wipe-and-rewrite seed entry point. Returns a per-domain row count so the
 * CLI and integration tests can assert insertion. Safe to call inside a test
 * harness that already opened a transaction — every operation routes through
 * the supplied `db` handle.
 */
export async function seed(opts: SeedOptions): Promise<SeedSummary> {
  const { db, logger } = opts;
  const truncate = opts.truncate ?? true;

  if (truncate) {
    logger?.info({ tables: TRUNCATE_TABLES.length }, 'seed: truncating tables');
    // RESTART IDENTITY resets driver_location_history's bigserial counter so
    // re-seeds produce identical ids on the partitioned write path.
    const quoted = TRUNCATE_TABLES.map((t) => `"${t}"`).join(', ');
    await db.execute(sql.raw(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`));
  }

  // -------- Users (customers + drivers + staff) ----------------------------
  const allUsers = [
    ...CUSTOMERS,
    ...DRIVER_USERS,
    ...STAFF.map((staff) => ({
      key: staff.userKey,
      email: staff.email,
      phone: `+1612555${String(9000 + STAFF.indexOf(staff)).padStart(4, '0')}`,
      role: staff.role === 'owner' ? ('owner' as const) : (staff.role as UserRole),
      status: 'active' as const,
      firstName: staff.firstName,
      lastName: staff.lastName,
      dateOfBirth: '1985-01-01',
      kycVerifiedAt: days(-180),
    })),
  ];

  await db.insert(schema.users).values(
    allUsers.map((user) => ({
      id: stableUuid('user', user.key),
      email: user.email,
      phone: user.phone,
      passwordHash: SEED_PASSWORD_HASH,
      role: user.role,
      status: user.status,
      firstName: user.firstName,
      lastName: user.lastName,
      dateOfBirth: user.dateOfBirth,
      kycVerifiedAt: user.kycVerifiedAt,
      kycProvider: user.kycVerifiedAt === null ? null : 'persona',
      kycProviderRef: user.kycVerifiedAt === null ? null : `persona-ref-${user.key}`,
      mfaEnabled: false,
      lastLoginAt: user.kycVerifiedAt === null ? null : days(-1),
      createdAt: user.kycVerifiedAt ?? days(-7),
      updatedAt: ANCHOR,
    })),
  );

  // -------- User addresses -------------------------------------------------
  for (const addr of ADDRESSES) {
    await db.insert(schema.userAddresses).values({
      id: stableUuid('address', addr.key),
      userId: stableUuid('user', addr.userKey),
      label: addr.label,
      line1: addr.line1,
      city: addr.city,
      region: 'MN',
      postalCode: addr.postalCode,
      country: 'US',
      location: pointToSql(addr.location),
      isDefault: true,
      isValidated: true,
      validatedAt: days(-7),
      createdAt: days(-7),
      updatedAt: ANCHOR,
    });
  }

  // -------- ID documents ---------------------------------------------------
  await db.insert(schema.userIdDocuments).values(
    ID_DOCUMENTS.map((doc) => ({
      id: stableUuid('id-doc', doc.key),
      userId: stableUuid('user', doc.userKey),
      type: doc.type,
      issuingRegion: 'MN',
      documentNumberHash: stableHash('id-doc-number', doc.key),
      verified: doc.verified,
      verifiedAt: doc.verified ? days(-30) : null,
      expiresAt: '2030-01-01',
      verificationProvider: 'persona',
      verificationRef: `persona-id-${doc.key}`,
      createdAt: days(-30),
      updatedAt: ANCHOR,
    })),
  );

  // -------- Dispensaries ---------------------------------------------------
  for (const disp of DISPENSARIES) {
    await db.insert(schema.dispensaries).values({
      id: stableUuid('dispensary', disp.key),
      legalName: disp.legalName,
      dba: disp.dba,
      licenseNumber: disp.licenseNumber,
      licenseType: disp.licenseType,
      licenseIssuedAt: '2025-07-01',
      licenseExpiresAt: '2026-12-31',
      posProvider: disp.posProvider,
      addressLine1: disp.addressLine1,
      city: disp.city,
      region: 'MN',
      postalCode: disp.postalCode,
      location: pointToSql(disp.location),
      deliveryPolygon: polygonToSql(disp.deliveryPolygon),
      hoursJson: HOURS_JSON,
      phone: disp.phone,
      email: disp.email,
      ratingAvg: disp.ratingAvg,
      ratingCount: disp.ratingCount,
      isAcceptingOrders: true,
      status: 'active',
      createdAt: days(-365),
      updatedAt: ANCHOR,
    });
  }

  // -------- Dispensary staff ----------------------------------------------
  await db.insert(schema.dispensaryStaff).values(
    STAFF.map((staff) => ({
      id: stableUuid('staff', staff.userKey),
      dispensaryId: stableUuid('dispensary', staff.dispensaryKey),
      userId: stableUuid('user', staff.userKey),
      role: staff.role,
      permissions: {},
      invitedAt: days(-365),
      acceptedAt: days(-360),
    })),
  );

  // -------- Driver records -------------------------------------------------
  await db.insert(schema.drivers).values(
    DRIVER_RECORDS.map((record) => ({
      id: stableUuid('driver', record.key),
      userId: stableUuid('user', record.userKey),
      licenseNumberHash: stableHash('driver-license', record.key),
      vehicleMake: record.vehicleMake,
      vehicleModel: record.vehicleModel,
      vehicleYear: record.vehicleYear,
      vehiclePlate: record.vehiclePlate,
      vehicleColor: record.vehicleColor,
      insuranceExpiresAt: record.insuranceExpiresAt,
      backgroundCheckPassedAt: '2025-06-01',
      backgroundCheckProviderRef: `checkr-${record.key}`,
      currentStatus: 'offline' as const,
      totalDeliveries: 0,
      createdAt: days(-200),
      updatedAt: ANCHOR,
    })),
  );

  // -------- Categories -----------------------------------------------------
  await db.insert(schema.productCategories).values(
    CATEGORIES.map((cat) => ({
      id: stableUuid('category', cat.key),
      slug: cat.slug,
      displayName: cat.displayName,
      displayOrder: cat.displayOrder,
    })),
  );

  // -------- Products -------------------------------------------------------
  await db.insert(schema.products).values(
    PRODUCTS.map((prod) => ({
      id: stableUuid('product', prod.key),
      categoryId: stableUuid('category', prod.categoryKey),
      brand: prod.brand,
      name: prod.name,
      description: prod.description,
      productType: prod.productType,
      strainType: prod.strainType,
      thcMgPerUnit: prod.thcMgPerUnit,
      cbdMgPerUnit: prod.cbdMgPerUnit,
      weightGramsPerUnit: prod.weightGramsPerUnit,
      servingCount: prod.servingCount,
      thcMgPerServing: prod.thcMgPerServing,
      effectsTags: [...prod.effectsTags],
      flavorTags: [...prod.flavorTags],
      isActive: true,
      createdAt: days(-90),
      updatedAt: ANCHOR,
    })),
  );

  // -------- Lab results — one per product, all passing --------------------
  await db.insert(schema.productLabResults).values(
    PRODUCTS.map((prod) => ({
      id: stableUuid('lab', prod.key),
      productId: stableUuid('product', prod.key),
      batchId: `BATCH-${prod.key.toUpperCase()}-2026A`,
      labName: 'Northland Analytical',
      potencyThc: (
        parseFloat(prod.thcMgPerUnit) /
        Math.max(parseFloat(prod.weightGramsPerUnit), 1) /
        10
      ).toFixed(3),
      potencyCbd: (
        parseFloat(prod.cbdMgPerUnit) /
        Math.max(parseFloat(prod.weightGramsPerUnit), 1) /
        10
      ).toFixed(3),
      contaminantsPassed: true,
      testedAt: '2026-01-01',
      createdAt: days(-14),
    })),
  );

  // -------- Listings ------------------------------------------------------
  const listingRows: schema.NewDispensaryListing[] = [];
  // MPLS: stocks everything at full price.
  for (const item of listingsFor('mpls', 1.0, new Set())) {
    listingRows.push({
      id: stableUuid('listing', `mpls-${item.productKey}`),
      dispensaryId: stableUuid('dispensary', 'mpls'),
      productId: stableUuid('product', item.productKey),
      sku: `MPLS-${item.productKey.toUpperCase()}`,
      priceCents: item.priceCents,
      quantityAvailable: item.quantity,
      metrcPackageTag: `1A4060300${item.productKey.length.toString().padStart(8, '0')}`,
      isActive: true,
      createdAt: days(-60),
      updatedAt: ANCHOR,
    });
  }
  // STP: skips beverages, prices 5% lower.
  const stpSkip = new Set(PRODUCTS.filter((p) => p.productType === 'beverage').map((p) => p.key));
  for (const item of listingsFor('stp', 0.95, stpSkip)) {
    listingRows.push({
      id: stableUuid('listing', `stp-${item.productKey}`),
      dispensaryId: stableUuid('dispensary', 'stp'),
      productId: stableUuid('product', item.productKey),
      sku: `STP-${item.productKey.toUpperCase()}`,
      priceCents: item.priceCents,
      quantityAvailable: item.quantity,
      metrcPackageTag: `1A4060301${item.productKey.length.toString().padStart(8, '0')}`,
      isActive: true,
      createdAt: days(-60),
      updatedAt: ANCHOR,
    });
  }
  // Maple Grove: only CBD/wellness focus — flower + CBD products only.
  const mgSkip = new Set(
    PRODUCTS.filter(
      (p) =>
        p.productType === 'concentrate' ||
        p.productType === 'vape' ||
        p.productType === 'infused_preroll',
    ).map((p) => p.key),
  );
  for (const item of listingsFor('mg', 1.05, mgSkip)) {
    listingRows.push({
      id: stableUuid('listing', `mg-${item.productKey}`),
      dispensaryId: stableUuid('dispensary', 'mg'),
      productId: stableUuid('product', item.productKey),
      sku: `MG-${item.productKey.toUpperCase()}`,
      priceCents: item.priceCents,
      quantityAvailable: item.quantity,
      metrcPackageTag: `1A4060302${item.productKey.length.toString().padStart(8, '0')}`,
      isActive: true,
      createdAt: days(-60),
      updatedAt: ANCHOR,
    });
  }
  await db.insert(schema.dispensaryListings).values(listingRows);

  // -------- Payment methods -----------------------------------------------
  await db.insert(schema.paymentMethods).values(
    PAYMENT_METHODS.map((pm) => ({
      id: stableUuid('payment-method', pm.key),
      userId: stableUuid('user', pm.userKey),
      type: pm.type,
      aeropayPaymentMethodRef: `aeropay-${pm.key}`,
      bankName: pm.bankName,
      last4: pm.last4,
      isDefault: true,
      status: pm.status,
      createdAt: days(-30),
      updatedAt: ANCHOR,
    })),
  );

  const summary: SeedSummary = {
    users: allUsers.length,
    dispensaries: DISPENSARIES.length,
    products: PRODUCTS.length,
    listings: listingRows.length,
    staff: STAFF.length,
    drivers: DRIVER_RECORDS.length,
    addresses: ADDRESSES.length,
    paymentMethods: PAYMENT_METHODS.length,
    idDocuments: ID_DOCUMENTS.length,
  };

  logger?.info(summary, 'seed: complete');
  return summary;
}
