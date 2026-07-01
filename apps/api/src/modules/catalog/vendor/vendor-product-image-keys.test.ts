/**
 * Unit tests for the vendor product image-key helpers — the contract shared by
 * the upload minter and the persist-time ownership validator.
 */
import { describe, expect, it } from 'vitest';
import {
  dispensaryAssetRoot,
  dispensaryProductImagePrefix,
  isProductImageKeyOwnedBy,
} from './vendor-product-image-keys.js';

const A = '01935f3d-0000-7000-8000-00000000000a';
const B = '01935f3d-0000-7000-8000-00000000000b';

describe('dispensaryProductImagePrefix', () => {
  it('embeds the dispensary id and the products asset segment', () => {
    expect(dispensaryProductImagePrefix(A)).toBe(`dispensaries/${A}/products/`);
  });
});

describe('isProductImageKeyOwnedBy', () => {
  it('accepts a key minted under the products prefix', () => {
    expect(isProductImageKeyOwnedBy(A, `${dispensaryProductImagePrefix(A)}018f.jpg`)).toBe(true);
  });

  it('accepts any key under the tenant root (reused listing/brand image)', () => {
    expect(isProductImageKeyOwnedBy(A, `${dispensaryAssetRoot(A)}listings/x.jpg`)).toBe(true);
  });

  it('rejects another tenant and unrelated keys', () => {
    expect(isProductImageKeyOwnedBy(A, `${dispensaryProductImagePrefix(B)}x.jpg`)).toBe(false);
    expect(isProductImageKeyOwnedBy(A, 'products/global/x.jpg')).toBe(false);
    expect(isProductImageKeyOwnedBy(A, '')).toBe(false);
  });

  it('rejects traversal/absolute/dot keys that would resolve cross-tenant', () => {
    expect(isProductImageKeyOwnedBy(A, `${dispensaryAssetRoot(A)}../${B}/products/x.jpg`)).toBe(
      false,
    );
    expect(isProductImageKeyOwnedBy(A, `/${dispensaryAssetRoot(A)}x.jpg`)).toBe(false);
    expect(isProductImageKeyOwnedBy(A, `${dispensaryAssetRoot(A)}./x.jpg`)).toBe(false);
  });
});
