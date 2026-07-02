import { OrderError } from '@dankdash/orders';
import { describe, expect, it, vi } from 'vitest';
import { createGeofenceObserver } from './geofence.observer.js';
import type { LocationIngestItem } from './types.js';
import type { Order, OrdersRepository } from '@dankdash/db';

// Minneapolis City Hall — same fixture as the service-test file.
const DROPOFF_LOCATION = { type: 'Point' as const, coordinates: [-93.26528, 44.97798] as const };
const DRIVER_A = '00000000-0000-0000-0000-00000000000a';
const DRIVER_B = '00000000-0000-0000-0000-00000000000b';
const ORDER_ID = '00000000-0000-0000-0000-0000000000aa';

interface CapturedLog {
  readonly level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

/**
 * Minimal pino-compatible logger fake. Matches the structural pattern used
 * by `dispatch.job.test.ts`: a narrow `child / info / warn / debug / error`
 * surface that satisfies what the observer actually calls. The full pino
 * `Logger` type has level-change subscriptions and custom-level generics
 * that don't matter for these tests, so we deliberately don't claim to
 * implement them — the cast at the call site is the price.
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
  readonly logger: Parameters<typeof createGeofenceObserver>[0]['logger'];
  readonly logs: CapturedLog[];
} {
  const logs: CapturedLog[] = [];
  return {
    logger: loggerInner(logs) as unknown as Parameters<typeof createGeofenceObserver>[0]['logger'],
    logs,
  };
}

function orderRow(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    shortCode: 'AB12CD',
    userId: '00000000-0000-0000-0000-0000000000c1',
    dispensaryId: '00000000-0000-0000-0000-0000000000d1',
    driverId: DRIVER_A,
    deliveryAddressId: '00000000-0000-0000-0000-0000000000e1',
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
  readonly applyTransition: ReturnType<typeof vi.fn>;
} {
  const findById = overrides.findById ?? vi.fn().mockResolvedValue(orderRow());
  const applyTransition = vi.fn().mockResolvedValue(orderRow({ status: 'arrived_at_dropoff' }));
  const orders = { findById, applyTransition } as unknown as OrdersRepository;
  return { orders, findById, applyTransition };
}

describe('createGeofenceObserver', () => {
  it('skips when the ping has no orderId (driver on duty but unassigned)', async () => {
    const { logger } = makeLogger();
    const { orders, findById, applyTransition } = buildRepo();

    const observer = createGeofenceObserver({ orders, logger });
    await observer(item({ orderId: null, lat: 44.97798, lng: -93.26528 }));

    expect(findById).not.toHaveBeenCalled();
    expect(applyTransition).not.toHaveBeenCalled();
  });

  it('skips when the order is not found (deleted between ping and read)', async () => {
    const { logger } = makeLogger();
    const findById = vi.fn().mockResolvedValue(null);
    const { orders, applyTransition } = buildRepo({ findById });

    const observer = createGeofenceObserver({ orders, logger });
    await observer(item({ lat: 44.97798, lng: -93.26528 }));

    expect(findById).toHaveBeenCalledWith(ORDER_ID);
    expect(applyTransition).not.toHaveBeenCalled();
  });

  it('skips when the order is not in en_route_dropoff (cheap pre-check)', async () => {
    const { logger } = makeLogger();
    const findById = vi.fn().mockResolvedValue(orderRow({ status: 'picked_up' }));
    const { orders, applyTransition } = buildRepo({ findById });

    const observer = createGeofenceObserver({ orders, logger });
    await observer(item({ lat: 44.97798, lng: -93.26528 }));

    expect(applyTransition).not.toHaveBeenCalled();
  });

  it('skips when the order is already at arrived_at_dropoff (idempotent fast path)', async () => {
    const { logger } = makeLogger();
    const findById = vi.fn().mockResolvedValue(orderRow({ status: 'arrived_at_dropoff' }));
    const { orders, applyTransition } = buildRepo({ findById });

    const observer = createGeofenceObserver({ orders, logger });
    await observer(item({ lat: 44.97798, lng: -93.26528 }));

    expect(applyTransition).not.toHaveBeenCalled();
  });

  it('skips when the payload driver no longer matches the order row driver', async () => {
    const { logger, logs } = makeLogger();
    const findById = vi.fn().mockResolvedValue(orderRow({ driverId: DRIVER_B }));
    const { orders, applyTransition } = buildRepo({ findById });

    const observer = createGeofenceObserver({ orders, logger });
    await observer(item({ driverId: DRIVER_A, lat: 44.97798, lng: -93.26528 }));

    expect(applyTransition).not.toHaveBeenCalled();
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('driver_id'))).toBe(true);
  });

  it('skips when the snapshot has no usable location (legacy row)', async () => {
    const { logger, logs } = makeLogger();
    const findById = vi
      .fn()
      .mockResolvedValue(orderRow({ deliveryAddressSnapshot: { location: null } }));
    const { orders, applyTransition } = buildRepo({ findById });

    const observer = createGeofenceObserver({ orders, logger });
    await observer(item({ lat: 44.97798, lng: -93.26528 }));

    expect(applyTransition).not.toHaveBeenCalled();
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('no usable location'))).toBe(
      true,
    );
  });

  it('skips when the driver is outside the 50m threshold', async () => {
    const { logger } = makeLogger();
    const { orders, applyTransition } = buildRepo();

    const observer = createGeofenceObserver({ orders, logger });
    // ~120m east of the dropoff
    await observer(item({ lat: 44.97798, lng: -93.26375 }));

    expect(applyTransition).not.toHaveBeenCalled();
  });

  it('fires DRIVER_ARRIVED when the driver crosses inside the threshold', async () => {
    const { logger, logs } = makeLogger();
    const { orders, applyTransition } = buildRepo();

    const observer = createGeofenceObserver({ orders, logger });
    await observer(item({ lat: 44.97798, lng: -93.26528, recordedAt: '2026-05-19T12:00:05.000Z' }));

    expect(applyTransition).toHaveBeenCalledTimes(1);
    const [orderIdArg, resolver] = applyTransition.mock.calls[0] as [
      string,
      (locked: { status: string; driverId: string | null }) => {
        toStatus: string;
        eventType: string;
        actorUserId?: string;
        actorRole?: string;
        payload?: Record<string, unknown>;
      },
    ];
    expect(orderIdArg).toBe(ORDER_ID);

    const decision = resolver({ status: 'en_route_dropoff', driverId: DRIVER_A });
    expect(decision.toStatus).toBe('arrived_at_dropoff');
    expect(decision.eventType).toBe('DRIVER_ARRIVED');
    expect(decision.actorRole).toBe('driver');
    expect(decision.actorUserId).toBe(DRIVER_A);
    expect(decision.payload).toMatchObject({
      trigger: 'geofence',
      lat: 44.97798,
      lng: -93.26528,
      recordedAt: '2026-05-19T12:00:05.000Z',
      thresholdMeters: 50,
    });

    expect(logs.some((l) => l.level === 'info' && l.message.includes('arrived_at_dropoff'))).toBe(
      true,
    );
  });

  it('honours an injected custom threshold (test seam)', async () => {
    const { logger } = makeLogger();
    const { orders, applyTransition } = buildRepo();

    // Default 50m would skip this point (~120m east); 200m threshold fires.
    const observer = createGeofenceObserver({ orders, logger, arrivalThresholdMeters: 200 });
    await observer(item({ lat: 44.97798, lng: -93.26375 }));

    expect(applyTransition).toHaveBeenCalledTimes(1);
  });

  it('swallows OrderError from applyTransition (race lost → already-arrived is benign)', async () => {
    const { logger, logs } = makeLogger();
    const findById = vi.fn().mockResolvedValue(orderRow());
    const applyTransition = vi
      .fn()
      .mockRejectedValueOnce(OrderError.invalidTransition('arrived_at_dropoff', 'DRIVER_ARRIVED'));
    const orders = { findById, applyTransition } as unknown as OrdersRepository;

    const observer = createGeofenceObserver({ orders, logger });
    await expect(observer(item({ lat: 44.97798, lng: -93.26528 }))).resolves.toBeUndefined();

    expect(applyTransition).toHaveBeenCalledOnce();
    expect(logs.some((l) => l.level === 'debug' && l.message.includes('lost race'))).toBe(true);
  });

  it('rethrows non-OrderError failures (DB outage, unexpected exception)', async () => {
    const { logger } = makeLogger();
    const findById = vi.fn().mockResolvedValue(orderRow());
    const applyTransition = vi.fn().mockRejectedValueOnce(new Error('connection refused'));
    const orders = { findById, applyTransition } as unknown as OrdersRepository;

    const observer = createGeofenceObserver({ orders, logger });

    await expect(observer(item({ lat: 44.97798, lng: -93.26528 }))).rejects.toThrow(
      'connection refused',
    );
  });

  it('only fires once across two pings in a row inside the geofence (idempotent)', async () => {
    const { logger } = makeLogger();
    // First findById sees en_route_dropoff; the transition flips the
    // row to arrived_at_dropoff and the second findById reflects that.
    const findById = vi
      .fn()
      .mockResolvedValueOnce(orderRow({ status: 'en_route_dropoff' }))
      .mockResolvedValueOnce(orderRow({ status: 'arrived_at_dropoff' }));
    const applyTransition = vi.fn().mockResolvedValue(orderRow({ status: 'arrived_at_dropoff' }));
    const orders = { findById, applyTransition } as unknown as OrdersRepository;

    const observer = createGeofenceObserver({ orders, logger });
    await observer(item({ lat: 44.97798, lng: -93.26528 }));
    await observer(item({ lat: 44.97798, lng: -93.26528 }));

    expect(applyTransition).toHaveBeenCalledTimes(1);
  });
});
