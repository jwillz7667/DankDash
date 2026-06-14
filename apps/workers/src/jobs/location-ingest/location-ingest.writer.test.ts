import { describe, expect, it, vi } from 'vitest';
import { writeLocationBatch } from './location-ingest.writer.js';
import type { LocationIngestItem } from './types.js';
import type { DriversRepository, DriverLocationHistoryRepository, GeoPoint } from '@dankdash/db';

function item(args: {
  readonly streamId?: string;
  readonly driverId: string;
  readonly orderId?: string | null;
  readonly customerId?: string | null;
  readonly lat: number;
  readonly lng: number;
  readonly accuracyMeters?: number | null;
  readonly speedMps?: number | null;
  readonly headingDeg?: number | null;
  readonly recordedAt: string;
}): LocationIngestItem {
  return {
    streamId: args.streamId ?? '0-0',
    payload: {
      driverId: args.driverId,
      orderId: args.orderId ?? null,
      customerId: args.customerId ?? null,
      dispensaryId: null,
      lat: args.lat,
      lng: args.lng,
      accuracyMeters: args.accuracyMeters ?? null,
      speedMps: args.speedMps ?? null,
      headingDeg: args.headingDeg ?? null,
      recordedAt: args.recordedAt,
    },
  };
}

interface UpdateCall {
  readonly driverId: string;
  readonly location: GeoPoint;
  readonly recordedAt: Date;
}

function buildDeps() {
  const recordBatch = vi.fn().mockResolvedValue(undefined);
  const updateCalls: UpdateCall[] = [];
  const updateLocation = vi
    .fn<(driverId: string, location: GeoPoint, recordedAt?: Date) => Promise<void>>()
    .mockImplementation((driverId, location, recordedAt) => {
      updateCalls.push({
        driverId,
        location,
        recordedAt: recordedAt ?? new Date(0),
      });
      return Promise.resolve();
    });

  const drivers = { updateLocation } as unknown as DriversRepository;
  const history = { recordBatch } as unknown as DriverLocationHistoryRepository;
  return { drivers, history, recordBatch, updateLocation, updateCalls };
}

const DRIVER_A = '00000000-0000-0000-0000-00000000000a';
const DRIVER_B = '00000000-0000-0000-0000-00000000000b';

describe('writeLocationBatch', () => {
  it('is a no-op for empty input', async () => {
    const { drivers, history, recordBatch, updateLocation } = buildDeps();

    const summary = await writeLocationBatch({ drivers, history }, []);

    expect(summary).toEqual({ historyRows: 0, driversUpdated: 0 });
    expect(recordBatch).not.toHaveBeenCalled();
    expect(updateLocation).not.toHaveBeenCalled();
  });

  it('bulk-inserts every item and updates each driver once with the latest point', async () => {
    const { drivers, history, recordBatch, updateLocation, updateCalls } = buildDeps();

    const items = [
      item({
        driverId: DRIVER_A,
        lat: 44.97,
        lng: -93.265,
        accuracyMeters: 8.5,
        recordedAt: '2026-05-19T12:00:00.000Z',
      }),
      item({
        driverId: DRIVER_A,
        lat: 44.98,
        lng: -93.27,
        accuracyMeters: 6.25,
        speedMps: 3.5,
        headingDeg: 270,
        recordedAt: '2026-05-19T12:00:05.000Z',
      }),
      item({
        driverId: DRIVER_B,
        lat: 45.0,
        lng: -93.3,
        recordedAt: '2026-05-19T12:00:01.000Z',
      }),
    ];

    const summary = await writeLocationBatch({ drivers, history }, items);

    expect(summary).toEqual({ historyRows: 3, driversUpdated: 2 });
    expect(recordBatch).toHaveBeenCalledOnce();

    const recordedRows = recordBatch.mock.calls[0]?.[0] as ReadonlyArray<{
      driverId: string;
      location: GeoPoint;
      accuracyMeters: string | null;
      speedMps: string | null;
      headingDeg: string | null;
      recordedAt: Date;
    }>;
    expect(recordedRows).toHaveLength(3);
    expect(recordedRows[0]?.location).toEqual({ type: 'Point', coordinates: [-93.265, 44.97] });
    expect(recordedRows[0]?.accuracyMeters).toBe('8.50');
    expect(recordedRows[1]?.speedMps).toBe('3.50');
    expect(recordedRows[1]?.headingDeg).toBe('270.00');
    expect(recordedRows[2]?.accuracyMeters).toBeNull();

    expect(updateLocation).toHaveBeenCalledTimes(2);
    const byDriver = new Map(updateCalls.map((c) => [c.driverId, c]));

    expect(byDriver.get(DRIVER_A)?.location).toEqual({
      type: 'Point',
      coordinates: [-93.27, 44.98],
    });
    expect(byDriver.get(DRIVER_A)?.recordedAt).toEqual(new Date('2026-05-19T12:00:05.000Z'));
    expect(byDriver.get(DRIVER_B)?.location).toEqual({
      type: 'Point',
      coordinates: [-93.3, 45.0],
    });
    expect(byDriver.get(DRIVER_B)?.recordedAt).toEqual(new Date('2026-05-19T12:00:01.000Z'));
  });

  it('picks the latest ping per driver even when out-of-order in the batch', async () => {
    const { drivers, history, updateCalls } = buildDeps();

    await writeLocationBatch({ drivers, history }, [
      item({ driverId: DRIVER_A, lat: 1, lng: 1, recordedAt: '2026-05-19T12:00:05.000Z' }),
      item({ driverId: DRIVER_A, lat: 2, lng: 2, recordedAt: '2026-05-19T12:00:01.000Z' }),
      item({ driverId: DRIVER_A, lat: 3, lng: 3, recordedAt: '2026-05-19T12:00:09.000Z' }),
      item({ driverId: DRIVER_A, lat: 4, lng: 4, recordedAt: '2026-05-19T12:00:07.000Z' }),
    ]);

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.location).toEqual({ type: 'Point', coordinates: [3, 3] });
    expect(updateCalls[0]?.recordedAt).toEqual(new Date('2026-05-19T12:00:09.000Z'));
  });
});
