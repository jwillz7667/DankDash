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
          dispensaryId: null,
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

  it('accepts a well-formed driver:location carrying order, customer, and dispensary', () => {
    const env: RealtimeEnvelope = {
      ...SAMPLE_ENVELOPE,
      event: {
        type: 'driver:location',
        payload: {
          driverId: '01900000-0000-7000-8000-000000000005',
          orderId: '01900000-0000-7000-8000-00000000000a',
          customerId: '01900000-0000-7000-8000-00000000000b',
          dispensaryId: '01900000-0000-7000-8000-00000000000d',
          lat: 44.9778,
          lng: -93.265,
          accuracyMeters: 8,
          speedMps: 5,
          headingDeg: 90,
          recordedAt: '2026-05-19T12:00:00.000Z',
        },
      },
    };
    const parsed = realtimeEnvelopeSchema.parse(env);
    expect(parsed.event.type).toBe('driver:location');
  });

  it('accepts a well-formed customer:eta_updated envelope', () => {
    const env: RealtimeEnvelope = {
      ...SAMPLE_ENVELOPE,
      event: {
        type: 'customer:eta_updated',
        payload: {
          orderId: '01900000-0000-7000-8000-00000000000a',
          customerId: '01900000-0000-7000-8000-00000000000b',
          driverId: '01900000-0000-7000-8000-00000000000c',
          etaSeconds: 540.5,
          distanceMeters: 3210,
          source: 'mapbox',
          computedAt: '2026-05-19T12:00:01.000Z',
        },
      },
    };
    const parsed = realtimeEnvelopeSchema.parse(env);
    expect(parsed.event.type).toBe('customer:eta_updated');
  });

  it('rejects a customer:eta_updated payload with a non-positive ETA', () => {
    const bad = {
      ...SAMPLE_ENVELOPE,
      event: {
        type: 'customer:eta_updated' as const,
        payload: {
          orderId: '01900000-0000-7000-8000-00000000000a',
          customerId: '01900000-0000-7000-8000-00000000000b',
          driverId: '01900000-0000-7000-8000-00000000000c',
          etaSeconds: 0,
          distanceMeters: 0,
          source: 'mapbox',
          computedAt: '2026-05-19T12:00:01.000Z',
        },
      },
    };
    expect(() => realtimeEnvelopeSchema.parse(bad)).toThrow();
  });

  it('rejects a customer:eta_updated payload with an unknown source', () => {
    const bad = {
      ...SAMPLE_ENVELOPE,
      event: {
        type: 'customer:eta_updated' as const,
        payload: {
          orderId: '01900000-0000-7000-8000-00000000000a',
          customerId: '01900000-0000-7000-8000-00000000000b',
          driverId: '01900000-0000-7000-8000-00000000000c',
          etaSeconds: 60,
          distanceMeters: 100,
          source: 'guess',
          computedAt: '2026-05-19T12:00:01.000Z',
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
