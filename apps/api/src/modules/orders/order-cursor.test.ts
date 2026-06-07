/**
 * Unit tests for the opaque orders-list cursor codec. The contract that
 * matters: a freshly-encoded cursor round-trips exactly, and every shape of
 * garbage decodes to `null` (so the DTO transform can reject it as a clean
 * 422 instead of paging from a bogus position).
 */
import { describe, expect, it } from 'vitest';
import { decodeOrderCursor, encodeOrderCursor, type OrderCursor } from './order-cursor.js';

const ID = '01935f3d-0000-7000-8000-000000001001';

describe('order-cursor', () => {
  it('round-trips a (placedAt, id) tuple', () => {
    const cursor: OrderCursor = { placedAt: new Date('2026-05-18T19:00:00.000Z'), id: ID };

    const decoded = decodeOrderCursor(encodeOrderCursor(cursor));

    expect(decoded).not.toBeNull();
    expect(decoded!.id).toBe(ID);
    expect(decoded!.placedAt.toISOString()).toBe('2026-05-18T19:00:00.000Z');
  });

  it('produces a URL-safe token (no +, /, or = padding)', () => {
    const token = encodeOrderCursor({ placedAt: new Date('2026-05-18T19:00:00.000Z'), id: ID });

    expect(token).not.toMatch(/[+/=]/);
  });

  it('returns null for a token with no separator', () => {
    const token = Buffer.from('no-separator-here', 'utf8').toString('base64url');

    expect(decodeOrderCursor(token)).toBeNull();
  });

  it('returns null when the id half is empty', () => {
    const token = Buffer.from('2026-05-18T19:00:00.000Z|', 'utf8').toString('base64url');

    expect(decodeOrderCursor(token)).toBeNull();
  });

  it('returns null when the timestamp is unparseable', () => {
    const token = Buffer.from(`not-a-date|${ID}`, 'utf8').toString('base64url');

    expect(decodeOrderCursor(token)).toBeNull();
  });

  it('returns null for a loose timestamp that does not re-serialise identically', () => {
    const token = Buffer.from(`2026-1-1|${ID}`, 'utf8').toString('base64url');

    expect(decodeOrderCursor(token)).toBeNull();
  });

  it('preserves an id that itself contains the separator char', () => {
    const cursor: OrderCursor = { placedAt: new Date('2026-05-18T19:00:00.000Z'), id: `a|b|c` };

    const decoded = decodeOrderCursor(encodeOrderCursor(cursor));

    expect(decoded!.id).toBe('a|b|c');
  });
});
