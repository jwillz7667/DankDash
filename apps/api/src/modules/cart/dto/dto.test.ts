/**
 * Unit tests for the cart DTOs.
 *
 *   CreateCartRequest — single field dispensaryId (uuid); rejects unknown
 *                       keys (`.strict()` so `userId` in body cannot be
 *                       forged).
 *   AddCartItemRequest — listingId + quantity (int, 1..9_999); rejects
 *                        decimals and unknown keys.
 *   PatchCartItemRequest — quantity only (int, 0..9_999); quantity=0
 *                          permitted at the schema layer (service routes
 *                          to remove).
 *   CartResponse  — projection shape; tests assert it accepts a
 *                   well-formed body and rejects field-shape drift.
 */
import { describe, expect, it } from 'vitest';
import {
  AddCartItemRequestSchema,
  CartResponseSchema,
  CreateCartRequestSchema,
  PatchCartItemRequestSchema,
  ValidateCartQuerySchema,
  ValidateCartResponseSchema,
} from './index.js';

const DISPENSARY_ID = '01935f3d-0000-7000-8000-000000000010';
const LISTING_ID = '01935f3d-0000-7000-8000-000000000030';

describe('CreateCartRequestSchema', () => {
  it('accepts a uuid dispensaryId', () => {
    expect(CreateCartRequestSchema.parse({ dispensaryId: DISPENSARY_ID })).toEqual({
      dispensaryId: DISPENSARY_ID,
    });
  });

  it('rejects a non-uuid dispensaryId', () => {
    expect(() => CreateCartRequestSchema.parse({ dispensaryId: 'not-a-uuid' })).toThrow();
  });

  it('rejects unknown top-level keys (strict)', () => {
    expect(() =>
      CreateCartRequestSchema.parse({ dispensaryId: DISPENSARY_ID, userId: 'spoofed' }),
    ).toThrow();
  });
});

describe('AddCartItemRequestSchema', () => {
  it('accepts a well-formed body', () => {
    expect(AddCartItemRequestSchema.parse({ listingId: LISTING_ID, quantity: 3 })).toEqual({
      listingId: LISTING_ID,
      quantity: 3,
    });
  });

  it('rejects quantity < 1', () => {
    expect(() => AddCartItemRequestSchema.parse({ listingId: LISTING_ID, quantity: 0 })).toThrow();
  });

  it('rejects quantity above the 9_999 cap', () => {
    expect(() =>
      AddCartItemRequestSchema.parse({ listingId: LISTING_ID, quantity: 10_000 }),
    ).toThrow();
  });

  it('rejects non-integer quantity', () => {
    expect(() =>
      AddCartItemRequestSchema.parse({ listingId: LISTING_ID, quantity: 1.5 }),
    ).toThrow();
  });

  it('rejects a non-uuid listingId', () => {
    expect(() =>
      AddCartItemRequestSchema.parse({ listingId: 'NS-PE-3.5G', quantity: 1 }),
    ).toThrow();
  });

  it('rejects unknown top-level keys (strict)', () => {
    expect(() =>
      AddCartItemRequestSchema.parse({
        listingId: LISTING_ID,
        quantity: 1,
        unitPriceCents: 99,
      }),
    ).toThrow();
  });
});

describe('PatchCartItemRequestSchema', () => {
  it('accepts quantity = 0 (service routes to remove)', () => {
    expect(PatchCartItemRequestSchema.parse({ quantity: 0 })).toEqual({ quantity: 0 });
  });

  it('accepts quantity > 0', () => {
    expect(PatchCartItemRequestSchema.parse({ quantity: 7 })).toEqual({ quantity: 7 });
  });

  it('rejects negative quantity', () => {
    expect(() => PatchCartItemRequestSchema.parse({ quantity: -1 })).toThrow();
  });

  it('rejects quantity above the 9_999 cap', () => {
    expect(() => PatchCartItemRequestSchema.parse({ quantity: 10_000 })).toThrow();
  });

  it('rejects unknown top-level keys (strict)', () => {
    expect(() =>
      PatchCartItemRequestSchema.parse({ quantity: 1, listingId: LISTING_ID }),
    ).toThrow();
  });
});

describe('CartResponseSchema', () => {
  const validResponse = {
    id: '01935f3d-0000-7000-8000-000000000020',
    userId: '01935f3d-0000-7000-8000-000000000001',
    dispensaryId: DISPENSARY_ID,
    items: [
      {
        id: '01935f3d-0000-7000-8000-000000000040',
        listingId: LISTING_ID,
        quantity: 2,
        unitPriceCents: 4500,
        lineSubtotalCents: 9000,
        createdAt: '2026-05-18T18:30:00.000Z',
        updatedAt: '2026-05-18T18:30:00.000Z',
      },
    ],
    subtotalCents: 9000,
    expiresAt: '2026-05-18T22:00:00.000Z',
    createdAt: '2026-05-18T18:00:00.000Z',
    updatedAt: '2026-05-18T18:30:00.000Z',
  } as const;

  it('parses a well-formed projection', () => {
    expect(CartResponseSchema.parse(validResponse)).toEqual(validResponse);
  });

  it('rejects negative subtotalCents', () => {
    expect(() => CartResponseSchema.parse({ ...validResponse, subtotalCents: -1 })).toThrow();
  });

  it('rejects non-ISO expiresAt', () => {
    expect(() => CartResponseSchema.parse({ ...validResponse, expiresAt: 'last week' })).toThrow();
  });
});

describe('ValidateCartQuerySchema', () => {
  const ADDRESS_ID = '01935f3d-0000-7000-8000-000000000060';

  it('accepts a uuid deliveryAddressId', () => {
    expect(ValidateCartQuerySchema.parse({ deliveryAddressId: ADDRESS_ID })).toEqual({
      deliveryAddressId: ADDRESS_ID,
    });
  });

  it('rejects a non-uuid deliveryAddressId', () => {
    expect(() => ValidateCartQuerySchema.parse({ deliveryAddressId: 'home' })).toThrow();
  });

  it('rejects a missing deliveryAddressId (the address is mandatory)', () => {
    expect(() => ValidateCartQuerySchema.parse({})).toThrow();
  });

  it('rejects unknown query keys (strict)', () => {
    expect(() =>
      ValidateCartQuerySchema.parse({
        deliveryAddressId: ADDRESS_ID,
        userId: 'spoofed',
      }),
    ).toThrow();
  });
});

describe('ValidateCartResponseSchema', () => {
  const validResponse = {
    passed: true,
    rules: [
      { rule: 'age', passed: true, details: {} },
      {
        rule: 'per_transaction_limit',
        passed: false,
        details: { flowerGramsOver: 2.8 },
      },
    ],
    cartTotals: { flowerGrams: 59.5, concentrateGrams: 0, edibleThcMg: 0 },
    limits: { flowerGramsMax: 56.7, concentrateGramsMax: 8, edibleThcMgMax: 800 },
    evaluatedAt: '2026-05-18T19:00:00.000Z',
    evaluationVersion: '1.0.0',
  } as const;

  it('parses a well-formed evaluation', () => {
    expect(ValidateCartResponseSchema.parse(validResponse)).toEqual(validResponse);
  });

  it('rejects an unknown rule id', () => {
    expect(() =>
      ValidateCartResponseSchema.parse({
        ...validResponse,
        rules: [{ rule: 'invented_rule', passed: true, details: {} }],
      }),
    ).toThrow();
  });

  it('rejects negative cartTotals (engine never emits them)', () => {
    expect(() =>
      ValidateCartResponseSchema.parse({
        ...validResponse,
        cartTotals: { flowerGrams: -1, concentrateGrams: 0, edibleThcMg: 0 },
      }),
    ).toThrow();
  });

  it('rejects non-positive statutory limits', () => {
    expect(() =>
      ValidateCartResponseSchema.parse({
        ...validResponse,
        limits: { flowerGramsMax: 0, concentrateGramsMax: 8, edibleThcMgMax: 800 },
      }),
    ).toThrow();
  });

  it('rejects a non-ISO evaluatedAt', () => {
    expect(() =>
      ValidateCartResponseSchema.parse({ ...validResponse, evaluatedAt: 'today' }),
    ).toThrow();
  });

  it('rejects an empty evaluationVersion', () => {
    expect(() =>
      ValidateCartResponseSchema.parse({ ...validResponse, evaluationVersion: '' }),
    ).toThrow();
  });

  it('rejects unknown top-level keys (strict)', () => {
    expect(() => ValidateCartResponseSchema.parse({ ...validResponse, extra: 'nope' })).toThrow();
  });
});
