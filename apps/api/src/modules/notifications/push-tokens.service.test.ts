/**
 * PushTokensService unit tests with hand-rolled in-memory fakes for the
 * PushTokensRepository. Coverage targets:
 *
 *   - register() forwards every field to repo.upsert and projects the row
 *     back into the response envelope.
 *   - deactivate() refuses cross-user access (NotFoundError), refuses
 *     missing rows (NotFoundError), is a no-op on already-deactivated
 *     rows, and calls repo.deactivate on the happy path.
 *
 * Fakes are explicit classes (not vi.fn()) so the call shapes are
 * inspectable as plain arrays — matches the convention in
 * payment-methods.service.test.ts.
 */
import { type NewPushToken, type PushToken, type PushTokensRepository } from '@dankdash/db';
import { NotFoundError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { PushTokensService } from './push-tokens.service.js';

const USER_ID = '01935f3d-0000-7000-8000-000000000001';
const OTHER_USER_ID = '01935f3d-0000-7000-8000-000000000002';
const TOKEN_ID = '01935f3d-0000-7000-8000-0000000000aa';
const DEVICE_ID = 'idfv-abcdef-12345';
const APNS_TOKEN = 'a'.repeat(64);

const CREATED_AT = new Date('2026-05-01T00:00:00.000Z');
const UPDATED_AT = new Date('2026-05-02T00:00:00.000Z');

function buildRow(overrides: Partial<PushToken> = {}): PushToken {
  return {
    id: TOKEN_ID,
    userId: USER_ID,
    deviceId: DEVICE_ID,
    apnsToken: APNS_TOKEN,
    platform: 'ios',
    appVariant: 'consumer',
    isActive: true,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

class FakePushTokensRepository {
  calls = {
    upsert: [] as NewPushToken[],
    findById: [] as string[],
    deactivate: [] as string[],
  };

  rowsById = new Map<string, PushToken>();
  upsertResponse: PushToken | undefined;

  setRow(row: PushToken): void {
    this.rowsById.set(row.id, row);
  }

  upsert = (input: Omit<NewPushToken, 'id'> & { readonly id?: string }): Promise<PushToken> => {
    const row: NewPushToken = { ...input, id: input.id ?? TOKEN_ID };
    this.calls.upsert.push(row);
    if (this.upsertResponse === undefined) {
      throw new TypeError('upsertResponse not configured');
    }
    return Promise.resolve(this.upsertResponse);
  };

  findById = (id: string): Promise<PushToken | null> => {
    this.calls.findById.push(id);
    return Promise.resolve(this.rowsById.get(id) ?? null);
  };

  deactivate = (id: string): Promise<void> => {
    this.calls.deactivate.push(id);
    const existing = this.rowsById.get(id);
    if (existing !== undefined) {
      this.rowsById.set(id, { ...existing, isActive: false, updatedAt: new Date() });
    }
    return Promise.resolve();
  };
}

describe('PushTokensService.register', () => {
  it('forwards every field to repo.upsert and projects the row', async () => {
    const repo = new FakePushTokensRepository();
    const row = buildRow();
    repo.upsertResponse = row;
    const service = new PushTokensService(repo as unknown as PushTokensRepository);

    const res = await service.register(USER_ID, {
      deviceId: DEVICE_ID,
      apnsToken: APNS_TOKEN,
      platform: 'ios',
      appVariant: 'consumer',
    });

    expect(repo.calls.upsert).toEqual([
      {
        id: TOKEN_ID,
        userId: USER_ID,
        deviceId: DEVICE_ID,
        apnsToken: APNS_TOKEN,
        platform: 'ios',
        appVariant: 'consumer',
        isActive: true,
      },
    ]);
    expect(res).toEqual({
      pushToken: {
        id: TOKEN_ID,
        deviceId: DEVICE_ID,
        platform: 'ios',
        appVariant: 'consumer',
        isActive: true,
        createdAt: CREATED_AT.toISOString(),
        updatedAt: UPDATED_AT.toISOString(),
      },
    });
  });

  it('threads the driver app variant through unchanged', async () => {
    const repo = new FakePushTokensRepository();
    repo.upsertResponse = buildRow({ appVariant: 'driver' });
    const service = new PushTokensService(repo as unknown as PushTokensRepository);

    const res = await service.register(USER_ID, {
      deviceId: DEVICE_ID,
      apnsToken: APNS_TOKEN,
      platform: 'ios',
      appVariant: 'driver',
    });

    expect(repo.calls.upsert[0]?.appVariant).toBe('driver');
    expect(res.pushToken.appVariant).toBe('driver');
  });
});

describe('PushTokensService.deactivate', () => {
  it('calls repo.deactivate on the happy path', async () => {
    const repo = new FakePushTokensRepository();
    repo.setRow(buildRow());
    const service = new PushTokensService(repo as unknown as PushTokensRepository);

    await service.deactivate(USER_ID, TOKEN_ID);

    expect(repo.calls.deactivate).toEqual([TOKEN_ID]);
  });

  it('returns NotFoundError when the row does not exist', async () => {
    const repo = new FakePushTokensRepository();
    const service = new PushTokensService(repo as unknown as PushTokensRepository);

    await expect(service.deactivate(USER_ID, TOKEN_ID)).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.calls.deactivate).toEqual([]);
  });

  it('returns NotFoundError when the row belongs to another user', async () => {
    const repo = new FakePushTokensRepository();
    repo.setRow(buildRow({ userId: OTHER_USER_ID }));
    const service = new PushTokensService(repo as unknown as PushTokensRepository);

    await expect(service.deactivate(USER_ID, TOKEN_ID)).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.calls.deactivate).toEqual([]);
  });

  it('is a no-op when the row is already deactivated', async () => {
    const repo = new FakePushTokensRepository();
    repo.setRow(buildRow({ isActive: false }));
    const service = new PushTokensService(repo as unknown as PushTokensRepository);

    await service.deactivate(USER_ID, TOKEN_ID);

    expect(repo.calls.deactivate).toEqual([]);
  });
});
