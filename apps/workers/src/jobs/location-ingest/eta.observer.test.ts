import { describe, expect, it, vi } from 'vitest';
import { createEtaObserver, type EtaComputer } from './eta.observer.js';
import type { LocationIngestItem } from './types.js';
import type { Order, OrdersRepository } from '@dankdash/db';
import type { PublishRealtimeEventInput } from '@dankdash/realtime-events';

// Minneapolis City Hall — reused across observer suites so a regression
// in one of the geo math packages surfaces here too.
const DROPOFF_LOCATION = { type: 'Point' as const, coordinates: [-93.26528, 44.97798] as const };
const DRIVER_A = '01900000-0000-7000-8000-00000000000a';
const DRIVER_B = '01900000-0000-7000-8000-00000000000b';
const CUSTOMER_ID = '01900000-0000-7000-8000-00000000000c';
const ORDER_ID = '01900000-0000-7000-8000-0000000000aa';
const EVENT_ID = '01900000-0000-7000-8000-0000000000e1';

interface CapturedLog {
  readonly level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

/**
 * Same pino-shaped capture logger pattern as geofence.observer.test.ts —
 * gives us a structural surface that satisfies what the observer calls
 * (`child`, `warn`) without claiming to implement the full pino API.
 */
function loggerInner(logs: CapturedLog[]): {
  child: (fields: Record<string, unknown>) => unknown;
  trace: (fields: Record<string, unknown>, message: string) => void;
  debug: (fields: Record<string, unknown>, message: string) => void;
  info: (fields: Record<string, unknown>, message: string) => void;
  warn: (fields: Record<string, unknown>, message: string) => void;
  error: (fields: Record<string, unknown>, message: string) => void;
  fatal: (fields: Record<string, unknown>, message: string) => void;
} {
  return {
    child: (): unknown => loggerInner(logs),
    trace: (fields, message): void => {
      logs.push({ level: 'trace', fields, message });
    },
    debug: (fields, message): void => {
      logs.push({ level: 'debug', fields, message });
    },
    info: (fields, message): void => {
      logs.push({ level: 'info', fields, message });
    },
    warn: (fields, message): void => {
      logs.push({ level: 'warn', fields, message });
    },
    error: (fields, message): void => {
      logs.push({ level: 'error', fields, message });
    },
    fatal: (fields, message): void => {
      logs.push({ level: 'fatal', fields, message });
    },
  };
}

function makeLogger(): {
  readonly logger: Parameters<typeof createEtaObserver>[0]['logger'];
  readonly logs: CapturedLog[];
} {
  const logs: CapturedLog[] = [];
  return {
    logger: loggerInner(logs) as unknown as Parameters<typeof createEtaObserver>[0]['logger'],
    logs,
  };
}

function orderRow(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    shortCode: 'AB12CD',
    userId: CUSTOMER_ID,
    dispensaryId: '01900000-0000-7000-8000-0000000000d1',
    driverId: DRIVER_A,
    deliveryAddressId: '01900000-0000-7000-8000-0000000000e1',
    status: 'en_route_dropoff',
    statusChangedAt: new Date('2026-05-19T11:59:00.000Z'),
    subtotalCents: 5000,
    cannabisTaxCents: 500,
    salesTaxCents: 350,
    deliveryFeeCents: 500,
    driverTipCents: 1000,
    discountCents: 0,
    promoCodeId: null,
    discountFundedBy: null,
    totalCents: 7350,
    complianceCheckPayload: {},
    deliveryAddressSnapshot: { location: DROPOFF_LOCATION },
    placedAt: new Date('2026-05-19T11:00:00.000Z'),
    paymentFailedAt: null,
    acceptedAt: null,
    rejectedAt: null,
    preppingAt: null,
    preparedAt: null,
    awaitingDriverAt: null,
    dispatchFailedAt: null,
    driverAssignedAt: null,
    enRoutePickupAt: null,
    pickedUpAt: null,
    enRouteDropoffAt: new Date('2026-05-19T11:30:00.000Z'),
    arrivedAtDropoffAt: null,
    idScanPendingAt: null,
    deliveredAt: null,
    returnedToStoreAt: null,
    canceledAt: null,
    canceledBy: null,
    cancelReason: null,
    disputedAt: null,
    deliveryIdScanRef: null,
    deliveryIdScanPassed: null,
    deliveryIdScanAt: null,
    customerRating: null,
    customerReview: null,
    dispensaryRating: null,
    driverRating: null,
    ratedAt: null,
    createdAt: new Date('2026-05-19T11:00:00.000Z'),
    updatedAt: new Date('2026-05-19T11:30:00.000Z'),
    ...overrides,
  };
}

function item(args: {
  readonly driverId?: string;
  readonly orderId?: string | null;
  readonly lat: number;
  readonly lng: number;
  readonly recordedAt?: string;
}): LocationIngestItem {
  return {
    streamId: '1700000000000-0',
    payload: {
      driverId: args.driverId ?? DRIVER_A,
      orderId: args.orderId === undefined ? ORDER_ID : args.orderId,
      customerId: null,
      dispensaryId: null,
      lat: args.lat,
      lng: args.lng,
      accuracyMeters: null,
      speedMps: null,
      headingDeg: null,
      recordedAt: args.recordedAt ?? '2026-05-19T12:00:05.000Z',
    },
  };
}

function buildRepo(overrides: { findById?: ReturnType<typeof vi.fn> } = {}): {
  readonly orders: OrdersRepository;
  readonly findById: ReturnType<typeof vi.fn>;
} {
  const findById = overrides.findById ?? vi.fn().mockResolvedValue(orderRow());
  const orders = { findById } as unknown as OrdersRepository;
  return { orders, findById };
}

function makeEta(
  result: Awaited<ReturnType<EtaComputer['computeEta']>> = {
    durationSeconds: 540,
    distanceMeters: 3210,
    source: 'mapbox',
  },
): { readonly eta: EtaComputer; readonly computeEta: ReturnType<typeof vi.fn> } {
  const computeEta = vi.fn().mockResolvedValue(result);
  return { eta: { computeEta }, computeEta };
}

function makePublish(): {
  readonly publish: (input: PublishRealtimeEventInput) => Promise<string>;
  readonly calls: PublishRealtimeEventInput[];
  readonly fail: (err: Error) => void;
} {
  const calls: PublishRealtimeEventInput[] = [];
  let nextError: Error | null = null;
  return {
    publish: (input) => {
      if (nextError !== null) {
        const e = nextError;
        nextError = null;
        return Promise.reject(e);
      }
      calls.push(input);
      return Promise.resolve('1700000000000-0');
    },
    calls,
    fail: (err) => {
      nextError = err;
    },
  };
}

describe('createEtaObserver', () => {
  it('skips when the ping has no orderId (driver between trips)', async () => {
    const { logger } = makeLogger();
    const { orders, findById } = buildRepo();
    const { eta, computeEta } = makeEta();
    const { publish, calls } = makePublish();

    const observer = createEtaObserver({
      orders,
      eta,
      publish,
      logger,
      idGen: () => EVENT_ID,
    });
    await observer(item({ orderId: null, lat: 44.978, lng: -93.265 }));

    expect(findById).not.toHaveBeenCalled();
    expect(computeEta).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('skips when the order is not found', async () => {
    const { logger } = makeLogger();
    const findById = vi.fn().mockResolvedValue(null);
    const { orders } = buildRepo({ findById });
    const { eta, computeEta } = makeEta();
    const { publish, calls } = makePublish();

    const observer = createEtaObserver({
      orders,
      eta,
      publish,
      logger,
      idGen: () => EVENT_ID,
    });
    await observer(item({ lat: 44.978, lng: -93.265 }));

    expect(computeEta).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('skips when the order is not in en_route_dropoff (customer screen has no live ETA yet)', async () => {
    const { logger } = makeLogger();
    const findById = vi.fn().mockResolvedValue(orderRow({ status: 'picked_up' }));
    const { orders } = buildRepo({ findById });
    const { eta, computeEta } = makeEta();
    const { publish, calls } = makePublish();

    const observer = createEtaObserver({
      orders,
      eta,
      publish,
      logger,
      idGen: () => EVENT_ID,
    });
    await observer(item({ lat: 44.978, lng: -93.265 }));

    expect(computeEta).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('skips when the order is past arrived_at_dropoff', async () => {
    const { logger } = makeLogger();
    const findById = vi.fn().mockResolvedValue(orderRow({ status: 'delivered' }));
    const { orders } = buildRepo({ findById });
    const { eta, computeEta } = makeEta();
    const { publish, calls } = makePublish();

    const observer = createEtaObserver({
      orders,
      eta,
      publish,
      logger,
      idGen: () => EVENT_ID,
    });
    await observer(item({ lat: 44.978, lng: -93.265 }));

    expect(computeEta).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('warns + skips when the payload driverId no longer matches the order row driverId', async () => {
    const { logger, logs } = makeLogger();
    const findById = vi.fn().mockResolvedValue(orderRow({ driverId: DRIVER_B }));
    const { orders } = buildRepo({ findById });
    const { eta, computeEta } = makeEta();
    const { publish, calls } = makePublish();

    const observer = createEtaObserver({
      orders,
      eta,
      publish,
      logger,
      idGen: () => EVENT_ID,
    });
    await observer(item({ driverId: DRIVER_A, lat: 44.978, lng: -93.265 }));

    expect(computeEta).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('driver_id'))).toBe(true);
  });

  it('warns + skips when the snapshot has no usable dropoff location', async () => {
    const { logger, logs } = makeLogger();
    const findById = vi
      .fn()
      .mockResolvedValue(orderRow({ deliveryAddressSnapshot: { location: null } }));
    const { orders } = buildRepo({ findById });
    const { eta, computeEta } = makeEta();
    const { publish, calls } = makePublish();

    const observer = createEtaObserver({
      orders,
      eta,
      publish,
      logger,
      idGen: () => EVENT_ID,
    });
    await observer(item({ lat: 44.978, lng: -93.265 }));

    expect(computeEta).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('no usable location'))).toBe(
      true,
    );
  });

  it('publishes customer:eta_updated with the mapbox source when computeEta resolves fresh', async () => {
    const { logger } = makeLogger();
    const { orders } = buildRepo();
    const { eta, computeEta } = makeEta({
      durationSeconds: 540.5,
      distanceMeters: 3210,
      source: 'mapbox',
    });
    const { publish, calls } = makePublish();

    const observer = createEtaObserver({
      orders,
      eta,
      publish,
      logger,
      idGen: () => EVENT_ID,
      clock: () => new Date('2026-05-19T12:00:05.000Z'),
    });
    await observer(item({ lat: 44.978, lng: -93.265, recordedAt: '2026-05-19T12:00:05.000Z' }));

    expect(computeEta).toHaveBeenCalledTimes(1);
    expect(computeEta).toHaveBeenCalledWith(
      { lat: 44.978, lng: -93.265 },
      { lat: 44.97798, lng: -93.26528 },
    );
    expect(calls).toHaveLength(1);
    const [published] = calls;
    expect(published).toMatchObject({
      id: EVENT_ID,
      emittedAt: '2026-05-19T12:00:05.000Z',
      source: 'workers',
      event: {
        type: 'customer:eta_updated',
        payload: {
          orderId: ORDER_ID,
          customerId: CUSTOMER_ID,
          driverId: DRIVER_A,
          etaSeconds: 540.5,
          distanceMeters: 3210,
          source: 'mapbox',
          computedAt: '2026-05-19T12:00:05.000Z',
        },
      },
    });
  });

  it('propagates source=cache through the published envelope', async () => {
    const { logger } = makeLogger();
    const { orders } = buildRepo();
    const { eta } = makeEta({
      durationSeconds: 300,
      distanceMeters: 2400,
      source: 'cache',
    });
    const { publish, calls } = makePublish();

    const observer = createEtaObserver({
      orders,
      eta,
      publish,
      logger,
      idGen: () => EVENT_ID,
    });
    await observer(item({ lat: 44.978, lng: -93.265 }));

    expect(calls[0]?.event.type).toBe('customer:eta_updated');
    if (calls[0]?.event.type === 'customer:eta_updated') {
      expect(calls[0].event.payload.source).toBe('cache');
    }
  });

  it('propagates source=fallback when EtaService degraded to haversine', async () => {
    const { logger } = makeLogger();
    const { orders } = buildRepo();
    const { eta } = makeEta({
      durationSeconds: 600,
      distanceMeters: 4800,
      source: 'fallback',
    });
    const { publish, calls } = makePublish();

    const observer = createEtaObserver({
      orders,
      eta,
      publish,
      logger,
      idGen: () => EVENT_ID,
    });
    await observer(item({ lat: 44.978, lng: -93.265 }));

    expect(calls[0]?.event.type).toBe('customer:eta_updated');
    if (calls[0]?.event.type === 'customer:eta_updated') {
      expect(calls[0].event.payload.source).toBe('fallback');
    }
  });

  it('skips publishing when ETA resolves to <=0 seconds (driver on top of dropoff)', async () => {
    const { logger } = makeLogger();
    const { orders } = buildRepo();
    const { eta, computeEta } = makeEta({
      durationSeconds: 0,
      distanceMeters: 0,
      source: 'fallback',
    });
    const { publish, calls } = makePublish();

    const observer = createEtaObserver({
      orders,
      eta,
      publish,
      logger,
      idGen: () => EVENT_ID,
    });
    await observer(item({ lat: 44.97798, lng: -93.26528 }));

    expect(computeEta).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it('does not rethrow when computeEta throws (geofence observer still gets its turn)', async () => {
    const { logger, logs } = makeLogger();
    const { orders } = buildRepo();
    const computeEta = vi.fn().mockRejectedValue(new TypeError('coords are NaN'));
    const eta: EtaComputer = { computeEta };
    const { publish, calls } = makePublish();

    const observer = createEtaObserver({
      orders,
      eta,
      publish,
      logger,
      idGen: () => EVENT_ID,
    });

    await expect(observer(item({ lat: 44.978, lng: -93.265 }))).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(logs.some((l) => l.level === 'warn' && l.fields.event === 'eta.compute_failed')).toBe(
      true,
    );
  });

  it('does not rethrow when publish throws (transient Redis outage)', async () => {
    const { logger, logs } = makeLogger();
    const { orders } = buildRepo();
    const { eta } = makeEta();
    const publisher = makePublish();
    publisher.fail(new Error('XADD failed: connection reset'));

    const observer = createEtaObserver({
      orders,
      eta,
      publish: publisher.publish,
      logger,
      idGen: () => EVENT_ID,
    });

    await expect(observer(item({ lat: 44.978, lng: -93.265 }))).resolves.toBeUndefined();
    expect(publisher.calls).toHaveLength(0);
    expect(logs.some((l) => l.level === 'warn' && l.fields.event === 'eta.publish_failed')).toBe(
      true,
    );
  });

  it('passes the driver ping coordinates to computeEta in (lat, lng) order', async () => {
    const { logger } = makeLogger();
    const { orders } = buildRepo();
    const { eta, computeEta } = makeEta();
    const { publish } = makePublish();

    const observer = createEtaObserver({
      orders,
      eta,
      publish,
      logger,
      idGen: () => EVENT_ID,
    });
    await observer(item({ lat: 44.99, lng: -93.27 }));

    expect(computeEta).toHaveBeenCalledWith(
      { lat: 44.99, lng: -93.27 },
      { lat: 44.97798, lng: -93.26528 },
    );
  });
});
