import { describe, expect, it } from 'vitest';
import { listingImageUrl } from './images.js';

describe('listingImageUrl', () => {
  const KEY = 'dispensaries/01935f3d-0000-7000-8000-0000000000d1/listings/abc.jpg';

  it('joins the base and key with a single slash', () => {
    expect(listingImageUrl(KEY, 'https://cdn.dankdash.test')).toBe(
      `https://cdn.dankdash.test/${KEY}`,
    );
  });

  it('strips trailing slashes from the base so the join never doubles up', () => {
    expect(listingImageUrl(KEY, 'https://cdn.dankdash.test/')).toBe(
      `https://cdn.dankdash.test/${KEY}`,
    );
    expect(listingImageUrl(KEY, 'https://cdn.dankdash.test///')).toBe(
      `https://cdn.dankdash.test/${KEY}`,
    );
  });

  it('strips leading slashes from the key', () => {
    expect(listingImageUrl(`/${KEY}`, 'https://cdn.dankdash.test')).toBe(
      `https://cdn.dankdash.test/${KEY}`,
    );
  });

  it('returns null when no base is configured (CDN not provisioned)', () => {
    expect(listingImageUrl(KEY, undefined)).toBeNull();
    expect(listingImageUrl(KEY, '')).toBeNull();
  });

  it('returns null for an empty key', () => {
    expect(listingImageUrl('', 'https://cdn.dankdash.test')).toBeNull();
    expect(listingImageUrl('///', 'https://cdn.dankdash.test')).toBeNull();
  });
});
