/**
 * Unit tests for AddressesService.
 *
 * The service composes a single repository (`UserAddressesRepository`).
 * The fake records every call + tracks `setDefault` invocations so the
 * test can assert the canonical singleton-flip path is used rather than
 * an inline `is_default: true` write. The scoped-repos factory is the
 * seam: the rig hands the service a closure returning the same fake
 * every call, matching the production path that builds tx-bound repos.
 *
 * Coverage focus:
 *   - listForUser: response shape mapping (GeoPoint → {latitude, longitude},
 *     ISO timestamps, null surfacing)
 *   - create: forwards lat/lng to GeoPoint, never sets `isDefault: true`
 *     inline (singleton flip goes through repo.setDefault)
 *   - create + setAsDefault: setDefault called exactly once
 *   - update: partial patch only forwards provided fields; absent fields
 *     are NOT spread into the repo payload (no clobbering with undefined)
 *   - update: lat+lng move together as a GeoPoint
 *   - update: cross-user / deleted / non-existent → NotFoundError
 *     (same response shape so a probe cannot distinguish ownership-fail
 *     from existence-fail)
 *   - update + isDefault: routes through setDefault
 *   - update with field edits + isDefault: both happen
 */
import { NotFoundError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { AddressesService, type AddressesScopedRepos } from './addresses.service.js';
import type {
  CreateUserAddressInput,
  Database,
  UpdateUserAddressPatch,
  UserAddress,
  UserAddressesRepository,
} from '@dankdash/db';

const USER_ID = '01935f3d-0000-7000-8000-000000000001';
const OTHER_USER_ID = '01935f3d-0000-7000-8000-0000000000ff';
const ADDRESS_ID = '01935f3d-0000-7000-8000-000000000020';
const ADDRESS_ID_2 = '01935f3d-0000-7000-8000-000000000021';

const FAKE_DB = {} as Database;

function makeAddress(overrides: Partial<UserAddress> = {}): UserAddress {
  const at = new Date('2026-05-15T18:00:00.000Z');
  return {
    id: ADDRESS_ID,
    userId: USER_ID,
    label: 'Home',
    line1: '100 Nicollet Mall',
    line2: null,
    city: 'Minneapolis',
    region: 'MN',
    postalCode: '55401',
    country: 'US',
    location: { type: 'Point', coordinates: [-93.27, 44.97] },
    isDefault: false,
    isValidated: false,
    validatedAt: null,
    deliveryInstructions: null,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    ...overrides,
  };
}

class FakeUserAddressesRepo implements Pick<
  UserAddressesRepository,
  'findById' | 'listForUser' | 'create' | 'update' | 'setDefault'
> {
  public listResponse: readonly UserAddress[] = [];
  public createResponse: UserAddress = makeAddress();
  public updateResponse: UserAddress | null = makeAddress();
  /** id → row. `findById` consults this first so post-mutation refreshes
   * return the row produced by the most recent setter. */
  public byId = new Map<string, UserAddress>();

  public createCalls: CreateUserAddressInput[] = [];
  public updateCalls: { id: string; patch: UpdateUserAddressPatch }[] = [];
  public setDefaultCalls: { userId: string; addressId: string }[] = [];

  findById = (id: string): Promise<UserAddress | null> => {
    return Promise.resolve(this.byId.get(id) ?? null);
  };

  listForUser = (_userId: string): Promise<readonly UserAddress[]> => {
    return Promise.resolve(this.listResponse);
  };

  create = (input: CreateUserAddressInput): Promise<UserAddress> => {
    this.createCalls.push(input);
    this.byId.set(this.createResponse.id, this.createResponse);
    return Promise.resolve(this.createResponse);
  };

  update = (id: string, patch: UpdateUserAddressPatch): Promise<UserAddress | null> => {
    this.updateCalls.push({ id, patch });
    if (this.updateResponse !== null) this.byId.set(id, this.updateResponse);
    return Promise.resolve(this.updateResponse);
  };

  setDefault = (userId: string, addressId: string): Promise<void> => {
    this.setDefaultCalls.push({ userId, addressId });
    return Promise.resolve();
  };
}

function makeService(): { service: AddressesService; repo: FakeUserAddressesRepo } {
  const repo = new FakeUserAddressesRepo();
  const scoped: AddressesScopedRepos = {
    userAddresses: repo as unknown as UserAddressesRepository,
  };
  const service = new AddressesService(FAKE_DB, () => scoped);
  return { service, repo };
}

describe('AddressesService.listForUser', () => {
  it('maps repo rows to wire shape — GeoPoint flattens to {latitude, longitude}', async () => {
    const { service, repo } = makeService();
    repo.listResponse = [
      makeAddress({
        id: ADDRESS_ID,
        isDefault: true,
        location: { type: 'Point', coordinates: [-93.265, 44.978] },
      }),
      makeAddress({
        id: ADDRESS_ID_2,
        label: 'Office',
        location: { type: 'Point', coordinates: [-93.27, 44.973] },
      }),
    ];

    const result = await service.listForUser(USER_ID);

    expect(result.addresses).toHaveLength(2);
    expect(result.addresses[0]?.location).toEqual({ latitude: 44.978, longitude: -93.265 });
    expect(result.addresses[0]?.isDefault).toBe(true);
    expect(result.addresses[1]?.label).toBe('Office');
    expect(result.addresses[0]?.createdAt).toBe('2026-05-15T18:00:00.000Z');
  });

  it('surfaces nullable fields as null (not undefined) so JSON serializes them', async () => {
    const { service, repo } = makeService();
    repo.listResponse = [
      makeAddress({
        label: null,
        line2: null,
        validatedAt: null,
        deliveryInstructions: null,
      }),
    ];

    const result = await service.listForUser(USER_ID);

    expect(result.addresses[0]?.label).toBeNull();
    expect(result.addresses[0]?.line2).toBeNull();
    expect(result.addresses[0]?.validatedAt).toBeNull();
    expect(result.addresses[0]?.deliveryInstructions).toBeNull();
  });

  it('serializes validatedAt to ISO string when present', async () => {
    const { service, repo } = makeService();
    repo.listResponse = [makeAddress({ validatedAt: new Date('2026-05-15T19:30:00.000Z') })];

    const result = await service.listForUser(USER_ID);

    expect(result.addresses[0]?.validatedAt).toBe('2026-05-15T19:30:00.000Z');
  });
});

describe('AddressesService.create', () => {
  it('forwards lat/lng as a GeoPoint with [longitude, latitude] order', async () => {
    const { service, repo } = makeService();
    repo.createResponse = makeAddress({
      location: { type: 'Point', coordinates: [-93.27, 44.97] },
    });

    await service.create(USER_ID, {
      label: 'Home',
      line1: '100 Nicollet Mall',
      city: 'Minneapolis',
      region: 'MN',
      postalCode: '55401',
      country: 'US',
      latitude: 44.97,
      longitude: -93.27,
    });

    expect(repo.createCalls).toHaveLength(1);
    expect(repo.createCalls[0]?.location).toEqual({
      type: 'Point',
      coordinates: [-93.27, 44.97],
    });
  });

  it('never sets isDefault: true inline — singleton flip goes through repo.setDefault', async () => {
    const { service, repo } = makeService();
    repo.createResponse = makeAddress();

    await service.create(USER_ID, {
      label: 'Home',
      line1: '100 Nicollet Mall',
      city: 'Minneapolis',
      region: 'MN',
      postalCode: '55401',
      country: 'US',
      latitude: 44.97,
      longitude: -93.27,
      setAsDefault: true,
    });

    expect(repo.createCalls[0]?.isDefault).toBe(false);
    expect(repo.setDefaultCalls).toEqual([{ userId: USER_ID, addressId: ADDRESS_ID }]);
  });

  it('does NOT call setDefault when setAsDefault is absent', async () => {
    const { service, repo } = makeService();

    await service.create(USER_ID, {
      label: 'Home',
      line1: '100 Nicollet Mall',
      city: 'Minneapolis',
      region: 'MN',
      postalCode: '55401',
      country: 'US',
      latitude: 44.97,
      longitude: -93.27,
    });

    expect(repo.setDefaultCalls).toEqual([]);
  });

  it('normalizes absent optional fields to null on the wire envelope', async () => {
    const { service, repo } = makeService();
    repo.createResponse = makeAddress({
      label: null,
      line2: null,
      deliveryInstructions: null,
    });

    await service.create(USER_ID, {
      line1: '100 Nicollet Mall',
      city: 'Minneapolis',
      region: 'MN',
      postalCode: '55401',
      country: 'US',
      latitude: 44.97,
      longitude: -93.27,
    });

    expect(repo.createCalls[0]?.label).toBeNull();
    expect(repo.createCalls[0]?.line2).toBeNull();
    expect(repo.createCalls[0]?.deliveryInstructions).toBeNull();
  });

  it('returns the post-refresh row so setDefault changes are reflected', async () => {
    const { service, repo } = makeService();
    repo.createResponse = makeAddress({ isDefault: false });
    // Simulate setDefault flipping isDefault=true; the second findById in
    // the service should see the updated row.
    const promotedRow = makeAddress({ isDefault: true });
    repo.byId.set(ADDRESS_ID, promotedRow);
    repo.setDefault = (userId, addressId) => {
      repo.setDefaultCalls.push({ userId, addressId });
      repo.byId.set(addressId, promotedRow);
      return Promise.resolve();
    };

    const result = await service.create(USER_ID, {
      line1: '100 Nicollet Mall',
      city: 'Minneapolis',
      region: 'MN',
      postalCode: '55401',
      country: 'US',
      latitude: 44.97,
      longitude: -93.27,
      setAsDefault: true,
    });

    expect(result.isDefault).toBe(true);
  });
});

describe('AddressesService.update', () => {
  it('forwards only provided fields — absent fields are NOT spread as undefined', async () => {
    const { service, repo } = makeService();
    repo.byId.set(ADDRESS_ID, makeAddress());
    repo.updateResponse = makeAddress({ label: 'Renamed' });

    await service.update(USER_ID, ADDRESS_ID, { label: 'Renamed' });

    expect(repo.updateCalls).toHaveLength(1);
    expect(repo.updateCalls[0]?.patch).toEqual({ label: 'Renamed' });
    // Belt-and-suspenders: the keys actually present on the payload
    // exclude every untouched field. Object.keys excludes undefined-spread
    // sentinels, so this guards against a regression that accidentally
    // forwards `undefined` values.
    expect(Object.keys(repo.updateCalls[0]?.patch ?? {})).toEqual(['label']);
  });

  it('moves lat + lng together as a GeoPoint with [longitude, latitude] order', async () => {
    const { service, repo } = makeService();
    repo.byId.set(ADDRESS_ID, makeAddress());
    repo.updateResponse = makeAddress();

    await service.update(USER_ID, ADDRESS_ID, {
      latitude: 44.985,
      longitude: -93.275,
    });

    expect(repo.updateCalls[0]?.patch.location).toEqual({
      type: 'Point',
      coordinates: [-93.275, 44.985],
    });
  });

  it('routes isDefault: true to repo.setDefault and does not call repo.update', async () => {
    const { service, repo } = makeService();
    repo.byId.set(ADDRESS_ID, makeAddress());

    await service.update(USER_ID, ADDRESS_ID, { isDefault: true });

    expect(repo.updateCalls).toEqual([]);
    expect(repo.setDefaultCalls).toEqual([{ userId: USER_ID, addressId: ADDRESS_ID }]);
  });

  it('does both repo.update and repo.setDefault when patch carries both', async () => {
    const { service, repo } = makeService();
    repo.byId.set(ADDRESS_ID, makeAddress());
    repo.updateResponse = makeAddress({ label: 'Renamed' });

    await service.update(USER_ID, ADDRESS_ID, { label: 'Renamed', isDefault: true });

    expect(repo.updateCalls).toHaveLength(1);
    expect(repo.updateCalls[0]?.patch).toEqual({ label: 'Renamed' });
    expect(repo.setDefaultCalls).toEqual([{ userId: USER_ID, addressId: ADDRESS_ID }]);
  });

  it('throws NotFoundError when the address belongs to a different user', async () => {
    const { service, repo } = makeService();
    repo.byId.set(ADDRESS_ID, makeAddress({ userId: OTHER_USER_ID }));

    await expect(service.update(USER_ID, ADDRESS_ID, { label: 'Renamed' })).rejects.toThrow(
      NotFoundError,
    );
    expect(repo.updateCalls).toEqual([]);
    expect(repo.setDefaultCalls).toEqual([]);
  });

  it('throws NotFoundError when the address is soft-deleted', async () => {
    const { service, repo } = makeService();
    repo.byId.set(ADDRESS_ID, makeAddress({ deletedAt: new Date('2026-05-14T00:00:00.000Z') }));

    await expect(service.update(USER_ID, ADDRESS_ID, { label: 'Renamed' })).rejects.toThrow(
      NotFoundError,
    );
  });

  it('throws NotFoundError when the address does not exist', async () => {
    const { service } = makeService();

    await expect(service.update(USER_ID, ADDRESS_ID, { label: 'Renamed' })).rejects.toThrow(
      NotFoundError,
    );
  });

  it('returns the post-update row so the wire envelope reflects the new values', async () => {
    const { service, repo } = makeService();
    repo.byId.set(ADDRESS_ID, makeAddress());
    const updated = makeAddress({ label: 'Renamed', city: 'Saint Paul' });
    repo.updateResponse = updated;

    const result = await service.update(USER_ID, ADDRESS_ID, {
      label: 'Renamed',
      city: 'Saint Paul',
    });

    expect(result.label).toBe('Renamed');
    expect(result.city).toBe('Saint Paul');
  });
});
