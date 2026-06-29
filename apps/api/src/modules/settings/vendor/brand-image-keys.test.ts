/**
 * Unit tests for the brand image-key helpers.
 *
 * These pin the contract shared by the upload minter
 * (VendorSettingsUploadsService) and the persist-time validator
 * (VendorSettingsService): a minted brand key must always be owned, and the
 * ownership check must fail closed on a cross-tenant key while staying
 * forgiving of any key under the dispensary's own root.
 */
import { describe, expect, it } from 'vitest';
import {
  dispensaryAssetRoot,
  dispensaryBrandImagePrefix,
  isBrandImageKeyOwnedBy,
} from './brand-image-keys.js';

const DISPENSARY_A = '01935f3d-0000-7000-8000-00000000000a';
const DISPENSARY_B = '01935f3d-0000-7000-8000-00000000000b';

describe('dispensaryBrandImagePrefix', () => {
  it('embeds the dispensary id and the brand asset segment', () => {
    expect(dispensaryBrandImagePrefix(DISPENSARY_A)).toBe(`dispensaries/${DISPENSARY_A}/brand/`);
  });

  it('produces a distinct prefix per dispensary', () => {
    expect(dispensaryBrandImagePrefix(DISPENSARY_A)).not.toBe(
      dispensaryBrandImagePrefix(DISPENSARY_B),
    );
  });
});

describe('isBrandImageKeyOwnedBy', () => {
  it('accepts a key minted under the brand prefix', () => {
    const key = `${dispensaryBrandImagePrefix(DISPENSARY_A)}018f-abc.jpg`;
    expect(isBrandImageKeyOwnedBy(DISPENSARY_A, key)).toBe(true);
  });

  it('accepts any key under the dispensary tenant root (admin-provisioned or listing photos)', () => {
    expect(isBrandImageKeyOwnedBy(DISPENSARY_A, `${dispensaryAssetRoot(DISPENSARY_A)}hero.jpg`)).toBe(
      true,
    );
    expect(
      isBrandImageKeyOwnedBy(DISPENSARY_A, `${dispensaryAssetRoot(DISPENSARY_A)}listings/x.jpg`),
    ).toBe(true);
  });

  it('rejects a key under another dispensary root', () => {
    const foreign = `${dispensaryBrandImagePrefix(DISPENSARY_B)}018f-abc.jpg`;
    expect(isBrandImageKeyOwnedBy(DISPENSARY_A, foreign)).toBe(false);
  });

  it('rejects a key that only resembles the root (no separator boundary)', () => {
    // A different dispensary id that shares a textual prefix must not pass —
    // the trailing slash in the root is the boundary guard.
    const lookalike = `dispensaries/${DISPENSARY_A}-evil/brand/x.jpg`;
    expect(isBrandImageKeyOwnedBy(DISPENSARY_A, lookalike)).toBe(false);
  });

  it('rejects an unrelated key and the empty string', () => {
    expect(isBrandImageKeyOwnedBy(DISPENSARY_A, 'products/global/x.jpg')).toBe(false);
    expect(isBrandImageKeyOwnedBy(DISPENSARY_A, '')).toBe(false);
  });
});
