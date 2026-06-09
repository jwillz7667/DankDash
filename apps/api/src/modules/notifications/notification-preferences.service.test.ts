/**
 * NotificationPreferencesService unit tests with a hand-rolled in-memory fake
 * for NotificationPreferencesRepository. Coverage targets:
 *
 *   - getForUser() returns the all-on defaults (updatedAt: null) WITHOUT
 *     writing a row when none exists, and never calls upsert on read.
 *   - getForUser() projects an existing row through unchanged.
 *   - update() forwards only the provided toggles to repo.upsert (partial
 *     patch) and projects the returned row.
 *   - update() with a single toggle does not send the others to the repo.
 *
 * The surface is self-scoped (no :id param, userId from the JWT), so there
 * is no cross-user/IDOR vector to test — a caller can only ever address
 * their own single row.
 *
 * Fakes are explicit classes (not vi.fn()) so call shapes are inspectable
 * as plain arrays — matches push-tokens.service.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { NotificationPreferencesService } from './notification-preferences.service.js';
import type { NotificationPreference, NotificationPreferencesRepository } from '@dankdash/db';

const USER_ID = '01935f3d-0000-7000-8000-000000000001';
const PREF_ID = '01935f3d-0000-7000-8000-0000000000cc';
const CREATED_AT = new Date('2026-05-01T00:00:00.000Z');
const UPDATED_AT = new Date('2026-05-02T00:00:00.000Z');

interface UpsertInput {
  readonly userId: string;
  readonly orderUpdatesEnabled?: boolean;
  readonly promotionsEnabled?: boolean;
  readonly pushEnabled?: boolean;
  readonly smsEnabled?: boolean;
  readonly emailEnabled?: boolean;
}

function buildRow(overrides: Partial<NotificationPreference> = {}): NotificationPreference {
  return {
    id: PREF_ID,
    userId: USER_ID,
    orderUpdatesEnabled: true,
    promotionsEnabled: true,
    pushEnabled: true,
    smsEnabled: true,
    emailEnabled: true,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

class FakeNotificationPreferencesRepository {
  calls = {
    findByUserId: [] as string[],
    upsert: [] as UpsertInput[],
  };
  rowsByUser = new Map<string, NotificationPreference>();
  upsertResponse: NotificationPreference | undefined;

  findByUserId = (userId: string): Promise<NotificationPreference | null> => {
    this.calls.findByUserId.push(userId);
    return Promise.resolve(this.rowsByUser.get(userId) ?? null);
  };

  upsert = (input: UpsertInput): Promise<NotificationPreference> => {
    this.calls.upsert.push(input);
    if (this.upsertResponse === undefined) {
      throw new TypeError('upsertResponse not configured');
    }
    return Promise.resolve(this.upsertResponse);
  };
}

function makeService(repo: FakeNotificationPreferencesRepository): NotificationPreferencesService {
  return new NotificationPreferencesService(repo as unknown as NotificationPreferencesRepository);
}

describe('NotificationPreferencesService.getForUser', () => {
  it('returns the all-on defaults without writing a row when none exists', async () => {
    const repo = new FakeNotificationPreferencesRepository();
    const service = makeService(repo);

    const res = await service.getForUser(USER_ID);

    expect(res).toEqual({
      orderUpdatesEnabled: true,
      promotionsEnabled: true,
      pushEnabled: true,
      smsEnabled: true,
      emailEnabled: true,
      updatedAt: null,
    });
    expect(repo.calls.findByUserId).toEqual([USER_ID]);
    expect(repo.calls.upsert).toEqual([]);
  });

  it('projects an existing row through unchanged', async () => {
    const repo = new FakeNotificationPreferencesRepository();
    repo.rowsByUser.set(USER_ID, buildRow({ promotionsEnabled: false, smsEnabled: false }));
    const service = makeService(repo);

    const res = await service.getForUser(USER_ID);

    expect(res).toEqual({
      orderUpdatesEnabled: true,
      promotionsEnabled: false,
      pushEnabled: true,
      smsEnabled: false,
      emailEnabled: true,
      updatedAt: UPDATED_AT.toISOString(),
    });
    expect(repo.calls.upsert).toEqual([]);
  });
});

describe('NotificationPreferencesService.update', () => {
  it('forwards only the provided toggles to repo.upsert and projects the row', async () => {
    const repo = new FakeNotificationPreferencesRepository();
    repo.upsertResponse = buildRow({ orderUpdatesEnabled: false, pushEnabled: false });
    const service = makeService(repo);

    const res = await service.update(USER_ID, {
      orderUpdatesEnabled: false,
      pushEnabled: false,
    });

    expect(repo.calls.upsert).toEqual([
      { userId: USER_ID, orderUpdatesEnabled: false, pushEnabled: false },
    ]);
    expect(res).toEqual({
      orderUpdatesEnabled: false,
      promotionsEnabled: true,
      pushEnabled: false,
      smsEnabled: true,
      emailEnabled: true,
      updatedAt: UPDATED_AT.toISOString(),
    });
  });

  it('does not send untouched toggles to the repo on a single-field patch', async () => {
    const repo = new FakeNotificationPreferencesRepository();
    repo.upsertResponse = buildRow({ emailEnabled: false });
    const service = makeService(repo);

    await service.update(USER_ID, { emailEnabled: false });

    expect(repo.calls.upsert).toEqual([{ userId: USER_ID, emailEnabled: false }]);
    const sent = repo.calls.upsert[0];
    expect(sent).toBeDefined();
    expect('orderUpdatesEnabled' in (sent ?? {})).toBe(false);
    expect('promotionsEnabled' in (sent ?? {})).toBe(false);
    expect('pushEnabled' in (sent ?? {})).toBe(false);
    expect('smsEnabled' in (sent ?? {})).toBe(false);
  });

  it('forwards a full five-toggle update verbatim', async () => {
    const repo = new FakeNotificationPreferencesRepository();
    repo.upsertResponse = buildRow({
      orderUpdatesEnabled: false,
      promotionsEnabled: false,
      pushEnabled: false,
      smsEnabled: false,
      emailEnabled: false,
    });
    const service = makeService(repo);

    await service.update(USER_ID, {
      orderUpdatesEnabled: false,
      promotionsEnabled: false,
      pushEnabled: false,
      smsEnabled: false,
      emailEnabled: false,
    });

    expect(repo.calls.upsert).toEqual([
      {
        userId: USER_ID,
        orderUpdatesEnabled: false,
        promotionsEnabled: false,
        pushEnabled: false,
        smsEnabled: false,
        emailEnabled: false,
      },
    ]);
  });
});
