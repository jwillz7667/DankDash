/**
 * Producer + consumer helpers for the `dankdash:realtime` Redis Stream.
 *
 * Stream layout:
 *   key  = `dankdash:realtime` (single global stream — partitioning by
 *          event type would force the consumer to subscribe to N streams
 *          and harm at-least-once ordering guarantees the room broadcasts
 *          rely on for `order:status_changed`).
 *   field = `envelope` with a single JSON-encoded RealtimeEnvelope value.
 *           Single field keeps XADD calls compact and parsing trivial.
 *
 * Caps:
 *   MAXLEN ~  100_000 on every XADD via `~` (probabilistic trim) — keeps
 *   the stream bounded without taking a per-call hit. At ~50 events/sec
 *   that gives ~30 min of replay headroom, which is enough for the
 *   consumer to catch up after a redeploy without unbounded growth.
 */
import { RepositoryError, ValidationError } from '@dankdash/types';
import { realtimeEnvelopeSchema, type RealtimeEnvelope, type RealtimeEvent } from './schemas.js';
import type { Redis } from 'ioredis';

export const REALTIME_STREAM_KEY = 'dankdash:realtime';
export const REALTIME_STREAM_FIELD = 'envelope';
export const REALTIME_STREAM_MAXLEN = 100_000;

export interface PublishRealtimeEventInput {
  readonly id: string;
  readonly emittedAt: string;
  readonly source: 'api' | 'workers';
  readonly event: RealtimeEvent;
}

/**
 * Atomic publish — validates the envelope before XADD so a malformed event
 * cannot land on the wire. Returns the assigned stream ID (`<ms>-<seq>`)
 * for tracing / tests; production callers usually discard it.
 *
 * The MAXLEN clause uses the approximate trim (`~`) which lets Redis trim
 * at radix-tree node boundaries — ~10x cheaper than the exact `=` form
 * and well within the bounded growth we want.
 */
export async function publishRealtimeEvent(
  redis: Redis,
  input: PublishRealtimeEventInput,
): Promise<string> {
  const envelope: RealtimeEnvelope = realtimeEnvelopeSchema.parse({
    id: input.id,
    emittedAt: input.emittedAt,
    source: input.source,
    event: input.event,
  });
  const id = await redis.xadd(
    REALTIME_STREAM_KEY,
    'MAXLEN',
    '~',
    REALTIME_STREAM_MAXLEN.toString(),
    '*',
    REALTIME_STREAM_FIELD,
    JSON.stringify(envelope),
  );
  if (id === null) {
    // XADD only returns null when NOMKSTREAM is set + the stream does not
    // exist. We never set NOMKSTREAM, so this branch is unreachable —
    // but keeping it explicit means a future signature change cannot
    // silently turn a publish into a no-op.
    throw new RepositoryError('XADD returned null — refusing to lose realtime event', {
      stream: REALTIME_STREAM_KEY,
    });
  }
  return id;
}

export interface DecodedStreamEntry {
  readonly streamId: string;
  readonly envelope: RealtimeEnvelope;
}

/**
 * Decode one Redis-Stream entry into a typed envelope. Throws on malformed
 * input — the consumer is expected to catch + log + skip, never crash the
 * read loop.
 */
export function decodeStreamEntry(streamId: string, fields: readonly string[]): DecodedStreamEntry {
  // ioredis returns alternating [field, value, field, value, ...] arrays.
  // We only emit one field per XADD so the lookup is just a linear scan
  // over at most 2 elements.
  let raw: string | undefined;
  for (let i = 0; i < fields.length; i += 2) {
    if (fields[i] === REALTIME_STREAM_FIELD) {
      raw = fields[i + 1];
      break;
    }
  }
  if (raw === undefined) {
    throw new ValidationError(`stream entry ${streamId} missing field "${REALTIME_STREAM_FIELD}"`, {
      streamId,
      field: REALTIME_STREAM_FIELD,
    });
  }

  // Validate at the boundary — never trust what came off the wire even
  // when both ends share the schema. A historical entry from a previous
  // schema version that no longer matches surfaces as a parse error here
  // and gets ACKed-and-dropped by the consumer rather than poisoning the
  // group's pending list.
  const parsed: unknown = JSON.parse(raw);
  const envelope = realtimeEnvelopeSchema.parse(parsed);
  return { streamId, envelope };
}
