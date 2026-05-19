import { describe, expect, it } from 'vitest';
import {
  decodeStreamEntry,
  realtimeEnvelopeSchema,
  REALTIME_STREAM_FIELD,
  type RealtimeEnvelope,
} from '../src/index.js';

const SAMPLE_ENVELOPE: RealtimeEnvelope = {
  id: '01900000-0000-7000-8000-000000000001',
  emittedAt: '2026-05-19T12:00:00.000Z',
  source: 'api',
  event: {
    type: 'order:status_changed',
    payload: {
      orderId: '01900000-0000-7000-8000-000000000002',
      customerId: '01900000-0000-7000-8000-000000000003',
      dispensaryId: '01900000-0000-7000-8000-000000000004',
      driverId: null,
      fromStatus: 'placed',
      toStatus: 'accepted',
      changedAt: '2026-05-19T12:00:00.000Z',
    },
  },
};

describe('realtime envelope schema', () => {
  it('accepts a well-formed envelope', () => {
    const parsed = realtimeEnvelopeSchema.parse(SAMPLE_ENVELOPE);
    expect(parsed.event.type).toBe('order:status_changed');
  });

  it('rejects an unknown event type', () => {
    const bad = { ...SAMPLE_ENVELOPE, event: { type: 'order:teleported', payload: {} } };
    expect(() => realtimeEnvelopeSchema.parse(bad)).toThrow();
  });

  it('rejects missing required payload fields', () => {
    const bad = {
      ...SAMPLE_ENVELOPE,
      event: {
        type: 'order:status_changed' as const,
        payload: {
          // missing orderId
          customerId: '01900000-0000-7000-8000-000000000003',
          dispensaryId: '01900000-0000-7000-8000-000000000004',
          driverId: null,
          fromStatus: 'placed',
          toStatus: 'accepted',
          changedAt: '2026-05-19T12:00:00.000Z',
        },
      },
    };
    expect(() => realtimeEnvelopeSchema.parse(bad)).toThrow();
  });

  it('rejects non-UUID identifiers', () => {
    const bad = { ...SAMPLE_ENVELOPE, id: 'not-a-uuid' };
    expect(() => realtimeEnvelopeSchema.parse(bad)).toThrow();
  });

  it('rejects malformed timestamps', () => {
    const bad = { ...SAMPLE_ENVELOPE, emittedAt: '2026-05-19' };
    expect(() => realtimeEnvelopeSchema.parse(bad)).toThrow();
  });

  it('validates driver:location lat/lng range', () => {
    const bad: RealtimeEnvelope = {
      ...SAMPLE_ENVELOPE,
      event: {
        type: 'driver:location',
        payload: {
          driverId: '01900000-0000-7000-8000-000000000005',
          orderId: null,
          customerId: null,
          lat: 91,
          lng: 0,
          accuracyMeters: null,
          speedMps: null,
          headingDeg: null,
          recordedAt: '2026-05-19T12:00:00.000Z',
        },
      },
    };
    expect(() => realtimeEnvelopeSchema.parse(bad)).toThrow();
  });
});

describe('decodeStreamEntry', () => {
  it('extracts and parses the envelope from a single-field xread result', () => {
    const fields = [REALTIME_STREAM_FIELD, JSON.stringify(SAMPLE_ENVELOPE)];
    const { streamId, envelope } = decodeStreamEntry('1700000000000-0', fields);
    expect(streamId).toBe('1700000000000-0');
    expect(envelope.event.type).toBe('order:status_changed');
  });

  it('throws when the canonical field is absent', () => {
    expect(() => decodeStreamEntry('id', ['unrelated', 'value'])).toThrow(/missing field/);
  });

  it('throws on malformed JSON', () => {
    expect(() => decodeStreamEntry('id', [REALTIME_STREAM_FIELD, '{not json}'])).toThrow();
  });

  it('throws on a JSON envelope that does not match the schema', () => {
    expect(() => decodeStreamEntry('id', [REALTIME_STREAM_FIELD, '{"foo": "bar"}'])).toThrow();
  });
});
