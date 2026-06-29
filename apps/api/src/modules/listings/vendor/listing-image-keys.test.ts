/**
 * Unit tests for the listing image-key prefix helper.
 *
 * This module is the single source of truth shared by the upload minter
 * (VendorListingUploadsService) and the persist-time validator
 * (VendorListingsService). The two must agree byte-for-byte: a minted key
 * the validator would reject is a broken upload, and a key the minter could
 * never produce that the validator accepts is a cross-tenant hole. These
 * tests pin the contract both sides depend on.
 */
import { describe, expect, it } from 'vitest';
import { dispensaryListingImagePrefix, isImageKeyOwnedBy } from './listing-image-keys.js';

const DISPENSARY_A = '01935f3d-0000-7000-8000-00000000000a';
const DISPENSARY_B = '01935f3d-0000-7000-8000-00000000000b';

describe('dispensaryListingImagePrefix', () => {
  it('embeds the dispensary id and the listings asset segment', () => {
    expect(dispensaryListingImagePrefix(DISPENSARY_A)).toBe(
      `dispensaries/${DISPENSARY_A}/listings/`,
    );
  });

  it('produces a distinct prefix per dispensary', () => {
    expect(dispensaryListingImagePrefix(DISPENSARY_A)).not.toBe(
      dispensaryListingImagePrefix(DISPENSARY_B),
    );
  });
});

describe('isImageKeyOwnedBy', () => {
  it('accepts a key minted under the dispensary prefix', () => {
    const key = `${dispensaryListingImagePrefix(DISPENSARY_A)}018f-abc.jpg`;
    expect(isImageKeyOwnedBy(DISPENSARY_A, key)).toBe(true);
  });

  it('rejects a key under another dispensary prefix', () => {
    const foreign = `${dispensaryListingImagePrefix(DISPENSARY_B)}018f-abc.jpg`;
    expect(isImageKeyOwnedBy(DISPENSARY_A, foreign)).toBe(false);
  });

  it('rejects a key that only resembles the prefix (no separator boundary)', () => {
    // A different dispensary id that happens to share a textual prefix must
    // not pass — the trailing slash in the prefix is the boundary guard.
    const lookalike = `dispensaries/${DISPENSARY_A}-evil/listings/x.jpg`;
    expect(isImageKeyOwnedBy(DISPENSARY_A, lookalike)).toBe(false);
  });

  it('rejects an unrelated key', () => {
    expect(isImageKeyOwnedBy(DISPENSARY_A, 'products/global/x.jpg')).toBe(false);
    expect(isImageKeyOwnedBy(DISPENSARY_A, '')).toBe(false);
  });

  it('rejects a traversal key that would resolve cross-tenant at the CDN', () => {
    // Starts with the prefix, but the `..` segments normalize to DISPENSARY_B.
    const traversal = `${dispensaryListingImagePrefix(DISPENSARY_A)}../../${DISPENSARY_B}/listings/x.jpg`;
    expect(traversal.startsWith(dispensaryListingImagePrefix(DISPENSARY_A))).toBe(true);
    expect(isImageKeyOwnedBy(DISPENSARY_A, traversal)).toBe(false);
  });
});
