/**
 * VendorSettingsService unit tests.
 *
 * The service is a small projection over DispensariesRepository plus an
 * `update`-by-id passthrough. Exercises:
 *
 *   - GET projects every editable + read-only field, never the encrypted
 *     credential blobs.
 *   - PATCH maps the wire keys onto the column names (hours → hoursJson)
 *     and only forwards fields the caller actually included.
 *   - GET/PATCH against a tombstoned or non-existent dispensary surface
 *     as NotFoundError (the JWT user could still have a session even
 *     after the platform admin tombstones their store).
 */
import { NotFoundError } from '@dankdash/types';
import type { Dispensary } from '@dankdash/db';
import { describe, expect, it } from 'vitest';
import { VendorSettingsService, type SettingsRepoFactory } from './vendor-settings.service.js';
import type { PatchVendorSettingsRequest } from './dto/index.js';
import type { VendorContext } from '../../listings/vendor/vendor-context.types.js';

const CTX: VendorContext = {
  dispensaryId: '01935f3d-0000-7000-8000-0000000000d1',
  userId: '01935f3d-0000-7000-8000-0000000000a1',
  staffRole: 'owner',
  staffMemberId: '01935f3d-0000-7000-8000-0000000000a2',
};

function makeDispensary(overrides: Partial<Dispensary> = {}): Dispensary {
  const base: Dispensary = {
    id: CTX.dispensaryId,
    legalName: 'North Star LLC',
    dba: 'North Star Cannabis',
    licenseNumber: 'MN-2025-0001',
    licenseType: 'retailer',
    licenseIssuedAt: '2025-01-01',
    licenseExpiresAt: '2027-01-01',
    metrcFacilityId: 'METRC-FAC-1',
    metrcApiKeyEnc: Buffer.from('encrypted'),
    posProvider: 'dutchie',
    posCredentialsEnc: Buffer.from('encrypted'),
    posLastSyncedAt: new Date('2026-05-19T18:00:00.000Z'),
    addressLine1: '1 Main St',
    addressLine2: null,
    city: 'Minneapolis',
    region: 'MN',
    postalCode: '55401',
    location: { type: 'Point', coordinates: [-93.265, 44.978] },
    deliveryPolygon: {
      type: 'Polygon',
      coordinates: [
        [
          [-93.3, 44.95],
          [-93.2, 44.95],
          [-93.2, 45.0],
          [-93.3, 45.0],
          [-93.3, 44.95],
        ],
      ],
    },
    hoursJson: {
      mon: { open: '08:00', close: '22:00' },
      tue: { open: '08:00', close: '22:00' },
      wed: { open: '08:00', close: '22:00' },
      thu: { open: '08:00', close: '22:00' },
      fri: { open: '08:00', close: '22:00' },
      sat: { open: '10:00', close: '22:00' },
      sun: null,
    },
    phone: '+1-612-555-0100',
    email: 'hi@northstar.example',
    logoImageKey: 'brands/north-star/logo.png',
    heroImageKey: 'brands/north-star/hero.png',
    brandColorHex: '#1A4314',
    aeropayAccountRef: 'aero_account_123',
    isAcceptingOrders: true,
    ratingAvg: '4.85',
    ratingCount: 200,
    status: 'active',
    createdAt: new Date('2025-12-15T00:00:00.000Z'),
    updatedAt: new Date('2026-05-15T00:00:00.000Z'),
    deletedAt: null,
  };
  return { ...base, ...overrides };
}

class FakeDispensariesRepo {
  public row: Dispensary | null;
  public updates: { id: string; patch: Record<string, unknown> }[] = [];

  constructor(row: Dispensary | null) {
    this.row = row;
  }

  findById = (id: string): Promise<Dispensary | null> => {
    if (this.row?.id !== id) return Promise.resolve(null);
    return Promise.resolve(this.row);
  };

  update = (id: string, patch: Record<string, unknown>): Promise<Dispensary | null> => {
    this.updates.push({ id, patch });
    if (this.row?.id !== id) return Promise.resolve(null);
    const next: Dispensary = { ...this.row, ...patch, updatedAt: new Date() } as Dispensary;
    this.row = next;
    return Promise.resolve(next);
  };
}

function makeService(repo: FakeDispensariesRepo): VendorSettingsService {
  const factory: SettingsRepoFactory = () => repo as unknown as ReturnType<SettingsRepoFactory>;
  return new VendorSettingsService(factory);
}

describe('VendorSettingsService.get', () => {
  it('projects every field including read-only siblings', async () => {
    const repo = new FakeDispensariesRepo(makeDispensary());
    const svc = makeService(repo);

    const result = await svc.get(CTX);

    expect(result.id).toBe(CTX.dispensaryId);
    expect(result.legalName).toBe('North Star LLC');
    expect(result.licenseNumber).toBe('MN-2025-0001');
    expect(result.licenseExpiresAt).toBe('2027-01-01');
    expect(result.hours).toEqual({
      mon: { open: '08:00', close: '22:00' },
      tue: { open: '08:00', close: '22:00' },
      wed: { open: '08:00', close: '22:00' },
      thu: { open: '08:00', close: '22:00' },
      fri: { open: '08:00', close: '22:00' },
      sat: { open: '10:00', close: '22:00' },
      sun: null,
    });
    expect(result.brandColorHex).toBe('#1A4314');
    expect(result.posProvider).toBe('dutchie');
    expect(result.posLastSyncedAt).toBe('2026-05-19T18:00:00.000Z');
    expect(result.metrcFacilityId).toBe('METRC-FAC-1');
  });

  it('reports integration credential presence as booleans only', async () => {
    const repo = new FakeDispensariesRepo(makeDispensary());
    const svc = makeService(repo);

    const result = await svc.get(CTX);

    expect(result.hasMetrcCredentials).toBe(true);
    expect(result.hasPosCredentials).toBe(true);
    expect(result.hasAeropayAccount).toBe(true);
    // Encrypted secrets must never leak through the response.
    expect(result).not.toHaveProperty('metrcApiKeyEnc');
    expect(result).not.toHaveProperty('posCredentialsEnc');
    expect(result).not.toHaveProperty('aeropayAccountRef');
  });

  it('reports false when credentials are absent', async () => {
    const repo = new FakeDispensariesRepo(
      makeDispensary({
        metrcApiKeyEnc: null,
        posCredentialsEnc: null,
        aeropayAccountRef: null,
      }),
    );
    const svc = makeService(repo);

    const result = await svc.get(CTX);

    expect(result.hasMetrcCredentials).toBe(false);
    expect(result.hasPosCredentials).toBe(false);
    expect(result.hasAeropayAccount).toBe(false);
  });

  it('404s when the dispensary does not exist', async () => {
    const repo = new FakeDispensariesRepo(null);
    const svc = makeService(repo);

    await expect(svc.get(CTX)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('404s when the dispensary is tombstoned', async () => {
    const repo = new FakeDispensariesRepo(
      makeDispensary({ deletedAt: new Date('2026-04-01T00:00:00.000Z') }),
    );
    const svc = makeService(repo);

    await expect(svc.get(CTX)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('VendorSettingsService.patch', () => {
  it('maps `hours` onto `hoursJson` for the repo update', async () => {
    const repo = new FakeDispensariesRepo(makeDispensary());
    const svc = makeService(repo);
    const body: PatchVendorSettingsRequest = {
      hours: {
        mon: { open: '09:00', close: '21:00' },
        tue: { open: '09:00', close: '21:00' },
        wed: { open: '09:00', close: '21:00' },
        thu: { open: '09:00', close: '21:00' },
        fri: { open: '09:00', close: '21:00' },
        sat: { open: '10:00', close: '20:00' },
        sun: null,
      },
    };

    await svc.patch(CTX, body);

    expect(repo.updates).toHaveLength(1);
    expect(repo.updates[0]?.id).toBe(CTX.dispensaryId);
    expect(repo.updates[0]?.patch).toEqual({ hoursJson: body.hours });
  });

  it('forwards only the keys the caller actually included', async () => {
    const repo = new FakeDispensariesRepo(makeDispensary());
    const svc = makeService(repo);

    await svc.patch(CTX, { isAcceptingOrders: false, brandColorHex: '#FF00AA' });

    expect(repo.updates[0]?.patch).toEqual({
      isAcceptingOrders: false,
      brandColorHex: '#FF00AA',
    });
  });

  it('accepts explicit null on nullable fields', async () => {
    const repo = new FakeDispensariesRepo(makeDispensary());
    const svc = makeService(repo);

    await svc.patch(CTX, { phone: null, email: null, brandColorHex: null });

    expect(repo.updates[0]?.patch).toEqual({
      phone: null,
      email: null,
      brandColorHex: null,
    });
  });

  it('returns the updated projection from the repo result', async () => {
    const repo = new FakeDispensariesRepo(makeDispensary());
    const svc = makeService(repo);

    const result = await svc.patch(CTX, { isAcceptingOrders: false });

    expect(result.isAcceptingOrders).toBe(false);
  });

  it('404s when the dispensary is gone before the patch lands', async () => {
    const repo = new FakeDispensariesRepo(null);
    const svc = makeService(repo);

    await expect(svc.patch(CTX, { isAcceptingOrders: false })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(repo.updates).toHaveLength(0);
  });
});
