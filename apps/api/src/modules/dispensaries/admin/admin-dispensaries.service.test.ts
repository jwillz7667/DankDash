/**
 * Unit tests for AdminDispensariesService.
 *
 * Behaviours pinned:
 *   - create()    forwards optional fields as null when omitted, rejects
 *                 duplicate licence numbers as ConflictError, returns the
 *                 inflated DispensaryResponse.
 *   - patch()     rejects empty bodies (422), 404s soft-deleted or missing
 *                 rows, cross-checks the persisted date against the patch
 *                 when only one date is being changed, and forwards every
 *                 present field to the repo update.
 *   - activate()  enforces the activation gate (licence not expired AND at
 *                 least one accepted owner), is idempotent on already-active
 *                 dispensaries, and refuses to revive terminated rows.
 *   - suspend()   transitions any non-terminated, non-deleted row to paused,
 *                 idempotent on already-paused, refuses terminated rows.
 *
 * `now` is pinned to a known instant so isOpenNow / opensAt assertions
 * are deterministic and the licence-expiry comparison can be exercised.
 */
import assert from 'node:assert/strict';
import { ConflictError, NotFoundError, RepositoryError, ValidationError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { MemoryCatalogCacheStore } from '../../catalog-cache/catalog-cache-store.js';
import { CatalogCacheService } from '../../catalog-cache/catalog-cache.service.js';
import { AdminDispensariesService } from './admin-dispensaries.service.js';
import type { CreateDispensaryRequest } from './dto/index.js';
import type {
  CreateDispensaryInput,
  Dispensary,
  DispensariesRepository,
  DispensaryStaffMember,
  DispensaryStaffRepository,
} from '@dankdash/db';

// 2026-05-18 (Mon) 14:00 America/Chicago = 19:00 UTC — store is open.
const NOON_MONDAY = new Date('2026-05-18T19:00:00.000Z');

const SAMPLE_HOURS = {
  mon: { open: '09:00', close: '22:00' },
  tue: { open: '09:00', close: '22:00' },
  wed: { open: '09:00', close: '22:00' },
  thu: { open: '09:00', close: '22:00' },
  fri: { open: '09:00', close: '22:00' },
  sat: { open: '10:00', close: '22:00' },
  sun: null,
};

const POINT = {
  type: 'Point' as const,
  coordinates: [-93.27, 44.97] as [number, number],
};
const POLYGON = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [-93.3, 44.9] as [number, number],
      [-93.2, 44.9] as [number, number],
      [-93.2, 45.0] as [number, number],
      [-93.3, 45.0] as [number, number],
      [-93.3, 44.9] as [number, number],
    ],
  ],
};

function makeDispensary(overrides: Partial<Dispensary> = {}): Dispensary {
  const createdAt = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: '01935f3d-0000-7000-8000-000000000001',
    legalName: 'North Star Cannabis Co.',
    dba: 'North Star',
    licenseNumber: 'OCM-12345',
    licenseType: 'retailer',
    licenseIssuedAt: '2024-01-01',
    licenseExpiresAt: '2028-01-01',
    metrcFacilityId: null,
    metrcApiKeyEnc: null,
    posProvider: 'manual',
    posCredentialsEnc: null,
    posLastSyncedAt: null,
    addressLine1: '100 Main St',
    addressLine2: null,
    city: 'Minneapolis',
    region: 'MN',
    postalCode: '55401',
    location: POINT,
    deliveryPolygon: POLYGON,
    hoursJson: SAMPLE_HOURS,
    phone: '+16125551234',
    email: 'orders@northstar.example',
    logoImageKey: null,
    heroImageKey: null,
    brandColorHex: null,
    aeropayAccountRef: null,
    isAcceptingOrders: false,
    ratingAvg: null,
    ratingCount: 0,
    status: 'onboarding',
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    ...overrides,
  };
}

function makeCreateBody(overrides: Partial<CreateDispensaryRequest> = {}): CreateDispensaryRequest {
  return {
    legalName: 'North Star Cannabis Co.',
    licenseNumber: 'OCM-12345',
    licenseType: 'retailer',
    licenseIssuedAt: '2024-01-01',
    licenseExpiresAt: '2028-01-01',
    addressLine1: '100 Main St',
    city: 'Minneapolis',
    region: 'MN',
    postalCode: '55401',
    location: POINT,
    deliveryPolygon: POLYGON,
    hours: SAMPLE_HOURS,
    ...overrides,
  };
}

class FakeDispensariesRepo implements Pick<
  DispensariesRepository,
  'findById' | 'findByLicenseNumber' | 'create' | 'update' | 'updateStatus'
> {
  public rows = new Map<string, Dispensary>();
  public byLicense = new Map<string, Dispensary>();
  public createCalls: CreateDispensaryInput[] = [];
  public updateCalls: { id: string; patch: Parameters<DispensariesRepository['update']>[1] }[] = [];
  public statusCalls: { id: string; status: Dispensary['status'] }[] = [];
  public nextCreated: Dispensary = makeDispensary();
  /** Forces `create` to mint a row with the supplied id. */
  public createdIdOverride: string | undefined = undefined;

  seed(d: Dispensary): void {
    this.rows.set(d.id, d);
    this.byLicense.set(d.licenseNumber, d);
  }

  findById(id: string): Promise<Dispensary | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  findByLicenseNumber(licenseNumber: string): Promise<Dispensary | null> {
    return Promise.resolve(this.byLicense.get(licenseNumber) ?? null);
  }

  create(input: CreateDispensaryInput): Promise<Dispensary> {
    this.createCalls.push(input);
    const row: Dispensary = {
      ...this.nextCreated,
      ...(this.createdIdOverride !== undefined ? { id: this.createdIdOverride } : {}),
      legalName: input.legalName,
      licenseNumber: input.licenseNumber,
      licenseType: input.licenseType,
      licenseIssuedAt: input.licenseIssuedAt,
      licenseExpiresAt: input.licenseExpiresAt,
      addressLine1: input.addressLine1,
      city: input.city,
      region: input.region,
      postalCode: input.postalCode,
      location: input.location,
      deliveryPolygon: input.deliveryPolygon,
      hoursJson: input.hoursJson,
      dba: input.dba ?? null,
      addressLine2: input.addressLine2 ?? null,
      metrcFacilityId: input.metrcFacilityId ?? null,
      posProvider: input.posProvider ?? 'manual',
      phone: input.phone ?? null,
      email: input.email ?? null,
      logoImageKey: input.logoImageKey ?? null,
      heroImageKey: input.heroImageKey ?? null,
      brandColorHex: input.brandColorHex ?? null,
    };
    this.rows.set(row.id, row);
    this.byLicense.set(row.licenseNumber, row);
    return Promise.resolve(row);
  }

  update(
    id: string,
    patch: Parameters<DispensariesRepository['update']>[1],
  ): Promise<Dispensary | null> {
    this.updateCalls.push({ id, patch });
    const existing = this.rows.get(id);
    if (existing === undefined) return Promise.resolve(null);
    const next: Dispensary = {
      ...existing,
      ...(patch as unknown as Partial<Dispensary>),
      updatedAt: new Date('2026-05-18T19:00:00.000Z'),
    };
    this.rows.set(id, next);
    return Promise.resolve(next);
  }

  updateStatus(id: string, status: Dispensary['status']): Promise<Dispensary | null> {
    this.statusCalls.push({ id, status });
    const existing = this.rows.get(id);
    if (existing === undefined) return Promise.resolve(null);
    const next: Dispensary = {
      ...existing,
      status,
      updatedAt: new Date('2026-05-18T19:00:00.000Z'),
    };
    this.rows.set(id, next);
    return Promise.resolve(next);
  }
}

class FakeStaffRepo implements Pick<DispensaryStaffRepository, 'listActiveForDispensary'> {
  public byDispensary = new Map<string, readonly DispensaryStaffMember[]>();
  public listCalls: string[] = [];

  seed(dispensaryId: string, members: readonly DispensaryStaffMember[]): void {
    this.byDispensary.set(dispensaryId, members);
  }

  listActiveForDispensary(dispensaryId: string): Promise<readonly DispensaryStaffMember[]> {
    this.listCalls.push(dispensaryId);
    return Promise.resolve(this.byDispensary.get(dispensaryId) ?? []);
  }
}

function makeStaff(overrides: Partial<DispensaryStaffMember> = {}): DispensaryStaffMember {
  return {
    id: '01935f3d-0000-7000-8000-0000000000e1',
    dispensaryId: '01935f3d-0000-7000-8000-000000000001',
    userId: '01935f3d-0000-7000-8000-0000000000f1',
    role: 'owner',
    permissions: {},
    invitedAt: new Date('2026-04-01T00:00:00.000Z'),
    invitedBy: null,
    acceptedAt: new Date('2026-04-02T00:00:00.000Z'),
    removedAt: null,
    ...overrides,
  };
}

interface Rig {
  readonly service: AdminDispensariesService;
  readonly dispensaries: FakeDispensariesRepo;
  readonly staff: FakeStaffRepo;
}

function makeRig(): Rig {
  const dispensaries = new FakeDispensariesRepo();
  const staff = new FakeStaffRepo();
  const cache = new CatalogCacheService(new MemoryCatalogCacheStore());
  const service = new AdminDispensariesService(
    dispensaries as unknown as DispensariesRepository,
    staff as unknown as DispensaryStaffRepository,
    cache,
  );
  return { service, dispensaries, staff };
}

describe('AdminDispensariesService.create', () => {
  it('forwards required fields and nulls every optional', async () => {
    const rig = makeRig();

    const res = await rig.service.create(makeCreateBody(), NOON_MONDAY);

    expect(rig.dispensaries.createCalls).toHaveLength(1);
    const input = rig.dispensaries.createCalls[0];
    assert(input !== undefined, 'expected create call');
    expect(input.legalName).toBe('North Star Cannabis Co.');
    expect(input.licenseNumber).toBe('OCM-12345');
    expect(input.licenseType).toBe('retailer');
    expect(input.dba).toBeNull();
    expect(input.addressLine2).toBeNull();
    expect(input.metrcFacilityId).toBeNull();
    expect(input.phone).toBeNull();
    expect(input.email).toBeNull();
    expect(input.brandColorHex).toBeNull();
    expect(input.location).toEqual(POINT);
    expect(input.deliveryPolygon).toEqual(POLYGON);
    expect(input.hoursJson).toEqual(SAMPLE_HOURS);
    // posProvider is omitted from the create input so the DB default applies.
    expect((input as { posProvider?: unknown }).posProvider).toBeUndefined();
    // Returned projection is the public read shape.
    expect(res.id).toBe('01935f3d-0000-7000-8000-000000000001');
    expect(res.legalName).toBe('North Star Cannabis Co.');
    expect(res.status).toBe('onboarding');
    expect(res.isOpenNow).toBe(true);
  });

  it('forwards posProvider when supplied', async () => {
    const rig = makeRig();

    await rig.service.create(makeCreateBody({ posProvider: 'dutchie' }), NOON_MONDAY);

    expect(rig.dispensaries.createCalls[0]?.posProvider).toBe('dutchie');
  });

  it('throws ConflictError on duplicate license number (pre-flight)', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary({ licenseNumber: 'OCM-12345' }));

    await expect(rig.service.create(makeCreateBody(), NOON_MONDAY)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(rig.dispensaries.createCalls).toEqual([]);
  });
});

describe('AdminDispensariesService.patch', () => {
  it('throws ValidationError on an empty patch body', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary());

    await expect(
      rig.service.patch('01935f3d-0000-7000-8000-000000000001', {}),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(rig.dispensaries.updateCalls).toEqual([]);
  });

  it('throws NotFoundError when the dispensary does not exist', async () => {
    const rig = makeRig();
    await expect(rig.service.patch('ghost', { legalName: 'Anything LLC' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('throws NotFoundError when the dispensary is soft-deleted', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary({ deletedAt: new Date('2026-04-01T00:00:00.000Z') }));

    await expect(
      rig.service.patch('01935f3d-0000-7000-8000-000000000001', { legalName: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('cross-checks the persisted licenseExpiresAt when only licenseIssuedAt is patched', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary({ licenseExpiresAt: '2026-06-01' }));

    await expect(
      rig.service.patch('01935f3d-0000-7000-8000-000000000001', { licenseIssuedAt: '2026-06-01' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('cross-checks the persisted licenseIssuedAt when only licenseExpiresAt is patched', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary({ licenseIssuedAt: '2026-06-01' }));

    await expect(
      rig.service.patch('01935f3d-0000-7000-8000-000000000001', {
        licenseExpiresAt: '2026-05-01',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('maps `hours` to `hoursJson` and forwards only present fields', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary());

    const res = await rig.service.patch(
      '01935f3d-0000-7000-8000-000000000001',
      { legalName: 'Renamed Co.', hours: SAMPLE_HOURS, isAcceptingOrders: true },
      NOON_MONDAY,
    );

    expect(rig.dispensaries.updateCalls).toHaveLength(1);
    const call = rig.dispensaries.updateCalls[0];
    assert(call !== undefined, 'expected update call');
    expect(call.id).toBe('01935f3d-0000-7000-8000-000000000001');
    expect(call.patch).toEqual({
      legalName: 'Renamed Co.',
      hoursJson: SAMPLE_HOURS,
      isAcceptingOrders: true,
    });
    expect(res.legalName).toBe('Renamed Co.');
    expect(res.isAcceptingOrders).toBe(true);
  });

  it('forwards a deliveryPolygon patch to the repo update', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary());
    const widened = {
      type: 'Polygon' as const,
      coordinates: [
        [
          [-93.85, 44.78] as [number, number],
          [-92.83, 44.78] as [number, number],
          [-92.83, 45.3] as [number, number],
          [-93.85, 45.3] as [number, number],
          [-93.85, 44.78] as [number, number],
        ],
      ],
    };

    await rig.service.patch(
      '01935f3d-0000-7000-8000-000000000001',
      { deliveryPolygon: widened },
      NOON_MONDAY,
    );

    expect(rig.dispensaries.updateCalls[0]?.patch).toEqual({ deliveryPolygon: widened });
  });

  it('allows nullable fields to be explicitly nulled', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary({ dba: 'North Star' }));

    await rig.service.patch(
      '01935f3d-0000-7000-8000-000000000001',
      { dba: null, addressLine2: null },
      NOON_MONDAY,
    );

    expect(rig.dispensaries.updateCalls[0]?.patch).toEqual({ dba: null, addressLine2: null });
  });
});

describe('AdminDispensariesService.activate', () => {
  it('promotes onboarding → active when the licence is valid and an accepted owner exists', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary({ status: 'onboarding' }));
    rig.staff.seed('01935f3d-0000-7000-8000-000000000001', [makeStaff()]);

    const res = await rig.service.activate('01935f3d-0000-7000-8000-000000000001', NOON_MONDAY);

    expect(rig.dispensaries.statusCalls).toEqual([
      { id: '01935f3d-0000-7000-8000-000000000001', status: 'active' },
    ]);
    expect(res.status).toBe('active');
  });

  it('is idempotent on already-active dispensaries (no status write)', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary({ status: 'active' }));

    const res = await rig.service.activate('01935f3d-0000-7000-8000-000000000001', NOON_MONDAY);

    expect(rig.dispensaries.statusCalls).toEqual([]);
    expect(res.status).toBe('active');
  });

  it('refuses to revive terminated dispensaries', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary({ status: 'terminated' }));

    await expect(
      rig.service.activate('01935f3d-0000-7000-8000-000000000001', NOON_MONDAY),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(rig.dispensaries.statusCalls).toEqual([]);
  });

  it('throws NotFoundError when the dispensary does not exist', async () => {
    const rig = makeRig();
    await expect(rig.service.activate('ghost', NOON_MONDAY)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws NotFoundError when the dispensary is soft-deleted', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary({ deletedAt: new Date('2026-04-01T00:00:00.000Z') }));
    await expect(
      rig.service.activate('01935f3d-0000-7000-8000-000000000001', NOON_MONDAY),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects activation when the licence is expired today', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary({ licenseExpiresAt: '2026-05-18' }));
    rig.staff.seed('01935f3d-0000-7000-8000-000000000001', [makeStaff()]);

    await expect(
      rig.service.activate('01935f3d-0000-7000-8000-000000000001', NOON_MONDAY),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects activation when no owner is attached', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary());
    // No staff seeded.

    await expect(
      rig.service.activate('01935f3d-0000-7000-8000-000000000001', NOON_MONDAY),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects activation when the owner has not accepted the invite yet', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary());
    rig.staff.seed('01935f3d-0000-7000-8000-000000000001', [makeStaff({ acceptedAt: null })]);

    await expect(
      rig.service.activate('01935f3d-0000-7000-8000-000000000001', NOON_MONDAY),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects activation when a non-owner staff is present but no owner', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary());
    rig.staff.seed('01935f3d-0000-7000-8000-000000000001', [makeStaff({ role: 'manager' })]);

    await expect(
      rig.service.activate('01935f3d-0000-7000-8000-000000000001', NOON_MONDAY),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws RepositoryError when the row vanishes between read and updateStatus', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary());
    rig.staff.seed('01935f3d-0000-7000-8000-000000000001', [makeStaff()]);
    rig.dispensaries.updateStatus = () => Promise.resolve(null);

    await expect(
      rig.service.activate('01935f3d-0000-7000-8000-000000000001', NOON_MONDAY),
    ).rejects.toBeInstanceOf(RepositoryError);
  });
});

describe('AdminDispensariesService.suspend', () => {
  it('transitions active → paused', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary({ status: 'active' }));

    const res = await rig.service.suspend('01935f3d-0000-7000-8000-000000000001', NOON_MONDAY);

    expect(rig.dispensaries.statusCalls).toEqual([
      { id: '01935f3d-0000-7000-8000-000000000001', status: 'paused' },
    ]);
    expect(res.status).toBe('paused');
  });

  it('is idempotent on already-paused dispensaries', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary({ status: 'paused' }));

    const res = await rig.service.suspend('01935f3d-0000-7000-8000-000000000001', NOON_MONDAY);

    expect(rig.dispensaries.statusCalls).toEqual([]);
    expect(res.status).toBe('paused');
  });

  it('refuses to suspend terminated dispensaries', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary({ status: 'terminated' }));

    await expect(
      rig.service.suspend('01935f3d-0000-7000-8000-000000000001', NOON_MONDAY),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws NotFoundError when the dispensary does not exist', async () => {
    const rig = makeRig();
    await expect(rig.service.suspend('ghost', NOON_MONDAY)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws NotFoundError when the dispensary is soft-deleted', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary({ deletedAt: new Date('2026-04-01T00:00:00.000Z') }));
    await expect(
      rig.service.suspend('01935f3d-0000-7000-8000-000000000001', NOON_MONDAY),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('transitions onboarding → paused (vendor-requested freeze before launch)', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary({ status: 'onboarding' }));

    const res = await rig.service.suspend('01935f3d-0000-7000-8000-000000000001', NOON_MONDAY);

    expect(rig.dispensaries.statusCalls).toEqual([
      { id: '01935f3d-0000-7000-8000-000000000001', status: 'paused' },
    ]);
    expect(res.status).toBe('paused');
  });
});
