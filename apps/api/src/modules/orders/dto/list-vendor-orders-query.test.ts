/**
 * Unit tests for ListVendorOrdersQuerySchema — covers the
 * comma-separated `statuses` filter parsing. The transform is the
 * only non-trivial piece of zod logic on the orders DTO surface and
 * the portal queue page depends on the default set, so it earns
 * dedicated coverage independent of the controller integration.
 */
import { describe, expect, it } from 'vitest';
import { ListVendorOrdersQuerySchema, VENDOR_QUEUE_DEFAULT_STATUSES } from './index.js';

describe('ListVendorOrdersQuerySchema', () => {
  it('uses the six-status default when statuses is absent', () => {
    const parsed = ListVendorOrdersQuerySchema.parse({});
    expect(parsed.statuses).toEqual([...VENDOR_QUEUE_DEFAULT_STATUSES]);
    expect(parsed.limit).toBe(200);
  });

  it('uses the default set when statuses is an empty string', () => {
    const parsed = ListVendorOrdersQuerySchema.parse({ statuses: '' });
    expect(parsed.statuses).toEqual([...VENDOR_QUEUE_DEFAULT_STATUSES]);
  });

  it('parses a single status', () => {
    const parsed = ListVendorOrdersQuerySchema.parse({ statuses: 'placed' });
    expect(parsed.statuses).toEqual(['placed']);
  });

  it('parses a comma-separated set with surrounding whitespace', () => {
    const parsed = ListVendorOrdersQuerySchema.parse({
      statuses: ' placed , accepted , prepping ',
    });
    expect(parsed.statuses).toEqual(['placed', 'accepted', 'prepping']);
  });

  it('coerces limit from a string query value', () => {
    const parsed = ListVendorOrdersQuerySchema.parse({ limit: '50' });
    expect(parsed.limit).toBe(50);
  });

  it('caps limit at 200 (rejects 201)', () => {
    expect(() => ListVendorOrdersQuerySchema.parse({ limit: 201 })).toThrowError();
  });

  it('rejects unknown statuses without falling back to the default', () => {
    expect(() =>
      ListVendorOrdersQuerySchema.parse({ statuses: 'placed,not-a-status' }),
    ).toThrowError(/unknown status: not-a-status/);
  });

  it('rejects unexpected query keys (strict mode)', () => {
    expect(() =>
      ListVendorOrdersQuerySchema.parse({ statuses: 'placed', unexpectedKey: 1 }),
    ).toThrowError();
  });
});
