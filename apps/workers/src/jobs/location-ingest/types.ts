/**
 * Internal shape carried through batcher → writer → optional observer.
 *
 * The stream consumer decodes a `RealtimeEnvelope` and narrows it to a
 * `driver:location` event before constructing a `LocationIngestItem`.
 * Downstream code never has to re-narrow the discriminated union — the
 * narrow happens once at the consumer's filter step.
 *
 * `streamId` is the Redis-Stream entry ID (`<ms>-<seq>`); we keep it
 * paired with the payload so the consumer can XACK the right entries
 * after a successful flush. Without it the consumer would need a parallel
 * array and the batcher's flush callback would have to receive two
 * related-but-unowned sequences — easy to desync.
 */
import type { DriverLocationPayload } from '@dankdash/realtime-events';

export interface LocationIngestItem {
  readonly streamId: string;
  readonly payload: DriverLocationPayload;
}
