/**
 * VendorOrderNotificationsListener tests — pins that a placed order fans a
 * `vendor.new_order` notification to every *accepted* staff member of the
 * dispensary, with the right payload and a per-order idempotency key, and
 * that the listener never throws.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { OrderPlacedEvent } from '../orders/order-placed.events.js';
import {
  type DispatchInput,
  type DispatchOutcome,
  type NotificationDispatcher,
} from './notification-dispatcher.service.js';
import { VendorOrderNotificationsListener } from './vendor-order-notifications.listener.js';
import type {
  Dispensary,
  DispensariesRepository,
  DispensaryStaffMember,
  DispensaryStaffRepository,
} from '@dankdash/db';
import type { NotificationTemplateKey } from '@dankdash/notifications';

const ORDER_ID = '01935f3d-0000-7000-8000-0000000000aa';
const CUSTOMER_ID = '01935f3d-0000-7000-8000-000000000001';
const DISPENSARY_ID = '01935f3d-0000-7000-8000-000000000010';
const OWNER_USER_ID = '01935f3d-0000-7000-8000-000000000031';
const MANAGER_USER_ID = '01935f3d-0000-7000-8000-000000000032';
const PENDING_USER_ID = '01935f3d-0000-7000-8000-000000000033';

const CREATED_AT = new Date('2026-05-01T00:00:00.000Z');

class FakeDispatcher {
  calls: Array<DispatchInput<NotificationTemplateKey>> = [];
  shouldThrow = false;

  dispatch = <TKey extends NotificationTemplateKey>(
    input: DispatchInput<TKey>,
  ): Promise<DispatchOutcome> => {
    if (this.shouldThrow) throw new TypeError('boom');
    this.calls.push(input);
    return Promise.resolve({ skipped: false, results: [] });
  };
}

class FakeDispensaries {
  rowsById = new Map<string, Dispensary>();

  findById = (id: string): Promise<Dispensary | null> =>
    Promise.resolve(this.rowsById.get(id) ?? null);
}

class FakeStaff {
  staffByDispensary = new Map<string, readonly DispensaryStaffMember[]>();

  listActiveForDispensary = (dispensaryId: string): Promise<readonly DispensaryStaffMember[]> =>
    Promise.resolve(this.staffByDispensary.get(dispensaryId) ?? []);
}

function buildDispensary(overrides: Partial<Dispensary> = {}): Dispensary {
  const base = {
    id: DISPENSARY_ID,
    legalName: 'Green Roots LLC',
    dba: 'Green Roots',
    licenseNumber: 'MN-CR-0001',
    licenseType: 'retailer',
    licenseIssuedAt: '2025-01-01',
    licenseExpiresAt: '2027-01-01',
    metrcFacilityId: null,
    metrcApiKeyEnc: null,
    posProvider: 'manual',
    posCredentialsEnc: null,
    posLastSyncedAt: null,
    addressLine1: '100 Test St',
    addressLine2: null,
    city: 'Minneapolis',
    region: 'MN',
    postalCode: '55401',
    location: { type: 'Point', coordinates: [-93.27, 44.97] },
    deliveryPolygon: {
      type: 'Polygon',
      coordinates: [
        [
          [-93.3, 44.9],
          [-93.2, 44.9],
          [-93.2, 45.0],
          [-93.3, 45.0],
          [-93.3, 44.9],
        ],
      ],
    },
    hoursJson: {},
    phone: null,
    email: null,
    logoImageKey: null,
    heroImageKey: null,
    brandColorHex: null,
    aeropayAccountRef: null,
    isAcceptingOrders: true,
    ratingAvg: null,
    ratingCount: 0,
    status: 'active',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    deletedAt: null,
  } satisfies Dispensary;
  return { ...base, ...overrides };
}

function buildStaff(
  userId: string,
  overrides: Partial<DispensaryStaffMember> = {},
): DispensaryStaffMember {
  return {
    id: `staff-${userId}`,
    dispensaryId: DISPENSARY_ID,
    userId,
    role: 'manager',
    permissions: {},
    invitedAt: CREATED_AT,
    invitedBy: null,
    acceptedAt: CREATED_AT,
    removedAt: null,
    ...overrides,
  };
}

function buildEvent(overrides: Partial<OrderPlacedEvent> = {}): OrderPlacedEvent {
  return new OrderPlacedEvent({
    orderId: ORDER_ID,
    customerId: CUSTOMER_ID,
    dispensaryId: DISPENSARY_ID,
    shortCode: 'AB123',
    totalCents: 6_250,
    status: 'placed',
    placedAt: CREATED_AT,
    ...overrides,
  });
}

interface Harness {
  readonly listener: VendorOrderNotificationsListener;
  readonly dispatcher: FakeDispatcher;
  readonly dispensaries: FakeDispensaries;
  readonly staff: FakeStaff;
}

function buildHarness(): Harness {
  const dispatcher = new FakeDispatcher();
  const dispensaries = new FakeDispensaries();
  const staff = new FakeStaff();
  const listener = new VendorOrderNotificationsListener({
    dispatcher: dispatcher as unknown as NotificationDispatcher,
    dispensaries: dispensaries as unknown as DispensariesRepository,
    staff: staff as unknown as DispensaryStaffRepository,
  });
  return { listener, dispatcher, dispensaries, staff };
}

describe('VendorOrderNotificationsListener', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
    h.dispensaries.rowsById.set(DISPENSARY_ID, buildDispensary());
  });

  it('fans vendor.new_order to every accepted staff member with the dba name', async () => {
    h.staff.staffByDispensary.set(DISPENSARY_ID, [
      buildStaff(OWNER_USER_ID, { role: 'owner' }),
      buildStaff(MANAGER_USER_ID),
    ]);

    await h.listener.onOrderPlaced(buildEvent());

    expect(h.dispatcher.calls).toEqual([
      {
        userId: OWNER_USER_ID,
        templateKey: 'vendor.new_order',
        payload: {
          orderId: ORDER_ID,
          shortCode: 'AB123',
          dispensaryName: 'Green Roots',
          totalCents: 6_250,
        },
        appVariant: 'consumer',
        idempotencyKey: ORDER_ID,
      },
      {
        userId: MANAGER_USER_ID,
        templateKey: 'vendor.new_order',
        payload: {
          orderId: ORDER_ID,
          shortCode: 'AB123',
          dispensaryName: 'Green Roots',
          totalCents: 6_250,
        },
        appVariant: 'consumer',
        idempotencyKey: ORDER_ID,
      },
    ]);
  });

  it('skips staff who have not accepted their invite', async () => {
    h.staff.staffByDispensary.set(DISPENSARY_ID, [
      buildStaff(MANAGER_USER_ID),
      buildStaff(PENDING_USER_ID, { acceptedAt: null }),
    ]);

    await h.listener.onOrderPlaced(buildEvent());

    expect(h.dispatcher.calls.map((c) => c.userId)).toEqual([MANAGER_USER_ID]);
  });

  it('falls back to legalName when dba is null', async () => {
    h.dispensaries.rowsById.set(DISPENSARY_ID, buildDispensary({ dba: null }));
    h.staff.staffByDispensary.set(DISPENSARY_ID, [buildStaff(MANAGER_USER_ID)]);

    await h.listener.onOrderPlaced(buildEvent());

    expect((h.dispatcher.calls[0]?.payload as { dispensaryName: string }).dispensaryName).toBe(
      'Green Roots LLC',
    );
  });

  it('does not dispatch when the dispensary has no active staff', async () => {
    h.staff.staffByDispensary.set(DISPENSARY_ID, []);

    await h.listener.onOrderPlaced(buildEvent());

    expect(h.dispatcher.calls).toEqual([]);
  });

  it('short-circuits when the dispensary row is missing (no throw)', async () => {
    h.dispensaries.rowsById.clear();

    await expect(h.listener.onOrderPlaced(buildEvent())).resolves.toBeUndefined();
    expect(h.dispatcher.calls).toEqual([]);
  });

  it('swallows dispatcher errors so the checkout response is never affected', async () => {
    h.staff.staffByDispensary.set(DISPENSARY_ID, [buildStaff(MANAGER_USER_ID)]);
    h.dispatcher.shouldThrow = true;

    await expect(h.listener.onOrderPlaced(buildEvent())).resolves.toBeUndefined();
  });
});
