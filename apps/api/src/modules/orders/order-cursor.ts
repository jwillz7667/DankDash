/**
 * Opaque keyset cursor for `GET /v1/orders`. Encodes the `(placedAt, id)`
 * tuple that pins the position immediately AFTER the last row of a page —
 * the same tuple `OrdersRepository.listForUserCursored` keys its
 * `(placedAt DESC, id DESC)` scan on. The token is base64url of
 * `<iso-8601>|<uuid>`: URL-safe, stable, and self-describing enough to
 * validate on the way back in.
 *
 * It carries no signature, and it doesn't need one. It exposes only the
 * placed-at timestamp and id of a row the caller already received, and the
 * query it parameterises is still scoped to the caller's own `userId`, so a
 * forged or tampered cursor can only re-page the forger's own history — it
 * cannot widen the result set or leak another user's orders.
 */
export interface OrderCursor {
  readonly placedAt: Date;
  readonly id: string;
}

const SEPARATOR = '|';

export function encodeOrderCursor(cursor: OrderCursor): string {
  const raw = `${cursor.placedAt.toISOString()}${SEPARATOR}${cursor.id}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/**
 * Decodes a cursor token, returning `null` for anything malformed so the
 * boundary (the `ListOrdersQuerySchema` transform) can map it to a clean
 * 422 rather than a silently-shifted page boundary. The round-trip guard
 * (`placedAt.toISOString() === isoPart`) rejects loose timestamps like
 * `2026-1-1` or trailing junk that `new Date(...)` would otherwise accept.
 */
export function decodeOrderCursor(token: string): OrderCursor | null {
  const decoded = Buffer.from(token, 'base64url').toString('utf8');
  const sep = decoded.indexOf(SEPARATOR);
  if (sep <= 0) return null;

  const isoPart = decoded.slice(0, sep);
  const idPart = decoded.slice(sep + 1);
  if (idPart.length === 0) return null;

  const placedAt = new Date(isoPart);
  if (Number.isNaN(placedAt.getTime()) || placedAt.toISOString() !== isoPart) return null;

  return { placedAt, id: idPart };
}
