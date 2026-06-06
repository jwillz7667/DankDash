/**
 * /v1/auth/forgot-password + /v1/auth/reset-password — end-to-end against
 * real Postgres through the Fastify adapter.
 *
 * The unit tests prove the service's branching; this proves the wiring the
 * unit tests can't see: the code minted in `requestReset` actually lands in a
 * `notifications` row (the only place the plaintext is ever rendered), the
 * controller's status codes, the DB-tier single-use + expiry semantics, and —
 * the security-critical end of the flow — that a completed reset lets the new
 * password authenticate, locks out the old one, and revokes pre-existing
 * sessions.
 *
 * The notification dedupe store is the one Redis dependency on this path; it
 * is overridden with the documented in-memory implementation so the suite
 * stays hermetic (no Redis container in globalSetup). Everything else — users,
 * tokens, sessions, the argon2 hasher — is the real wiring.
 */
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/build-app.js';
import type { NotificationDedupeStore } from '../../src/modules/notifications/notification-dedupe.store.js';
import { getPool, resetRateLimit, truncateFixtures } from './setup.js';

const NOTIFICATION_DEDUPE = Symbol.for('NOTIFICATIONS_DEDUPE');
const DISPLAY_CODE = /[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/u;
const NEW_PASSWORD = 'reset-flow-pass-9921';

/** Documented in-memory swap for RedisNotificationDedupeStore. */
class MemoryDedupeStore implements NotificationDedupeStore {
  private readonly keys = new Set<string>();
  acquire(key: string): Promise<boolean> {
    if (this.keys.has(key)) return Promise.resolve(false);
    this.keys.add(key);
    return Promise.resolve(true);
  }
}

interface RegisterResult {
  readonly userId: string;
  readonly refreshToken: string;
}

interface ErrorBody {
  readonly error: { readonly code: string };
}

describe('/v1/auth password reset — forgot → reset → login', () => {
  let app: NestFastifyApplication;
  let emailSeq = 0;

  beforeAll(async () => {
    app = await buildTestApp({
      overrides: [{ token: NOTIFICATION_DEDUPE, value: new MemoryDedupeStore() }],
    });
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateFixtures();
    // Aggressive per-route limits would otherwise accumulate across the file.
    resetRateLimit(app);
  });

  function nextEmail(): string {
    emailSeq += 1;
    return `reset.user.${String(emailSeq)}@example.com`;
  }

  async function register(email: string, password: string): Promise<RegisterResult> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: {
        email,
        password,
        dateOfBirth: '1990-01-01',
        firstName: 'Reset',
        lastName: 'User',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{ user: { id: string }; tokens: { refreshToken: string } }>();
    return { userId: body.user.id, refreshToken: body.tokens.refreshToken };
  }

  async function readResetCode(userId: string): Promise<string> {
    const rows = await getPool().sql.unsafe<{ payload: { text?: string } }[]>(
      `SELECT payload FROM notifications
         WHERE user_id = $1 AND template_key = 'auth.password_reset'
         ORDER BY created_at DESC
         LIMIT 1`,
      [userId],
    );
    expect(rows).toHaveLength(1);
    const text = rows[0]?.payload.text ?? '';
    const match = DISPLAY_CODE.exec(text);
    expect(match, `reset email did not contain a code: ${text}`).not.toBeNull();
    return match![0];
  }

  async function forgot(email: string): Promise<number> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/forgot-password',
      headers: { 'content-type': 'application/json' },
      payload: { email },
    });
    return res.statusCode;
  }

  async function reset(code: string, newPassword: string): Promise<number> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      headers: { 'content-type': 'application/json' },
      payload: { code, newPassword },
    });
    return res.statusCode;
  }

  it('completes the full lifecycle: new password works, old one and old sessions die', async () => {
    const email = nextEmail();
    const oldPassword = 'original-pass-12345';
    const { userId, refreshToken } = await register(email, oldPassword);

    expect(await forgot(email)).toBe(202);
    const code = await readResetCode(userId);

    expect(await reset(code, NEW_PASSWORD)).toBe(204);

    // New password authenticates.
    const loginNew = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email, password: NEW_PASSWORD },
    });
    expect(loginNew.statusCode, loginNew.body).toBe(200);
    expect(loginNew.json<{ status: string }>().status).toBe('authenticated');

    // Old password no longer works.
    const loginOld = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email, password: oldPassword },
    });
    expect(loginOld.statusCode).toBe(401);
    expect(loginOld.json<ErrorBody>().error.code).toBe('INVALID_CREDENTIALS');

    // The session minted at registration was revoked by the reset.
    const refreshOld = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { 'content-type': 'application/json' },
      payload: { refreshToken },
    });
    expect(refreshOld.statusCode).toBe(401);
  });

  it('returns 202 for an unknown email and writes no notification (enumeration-safe)', async () => {
    expect(await forgot('ghost.account@example.com')).toBe(202);

    const rows = await getPool().sql.unsafe<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count FROM notifications WHERE template_key = 'auth.password_reset'`,
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('rejects an unknown / malformed code with 401 TOKEN_INVALID', async () => {
    const status = await reset('ZZZZ-ZZZZ-ZZZZ', NEW_PASSWORD);
    expect(status).toBe(401);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      headers: { 'content-type': 'application/json' },
      payload: { code: 'ZZZZ-ZZZZ-ZZZZ', newPassword: NEW_PASSWORD },
    });
    expect(res.json<ErrorBody>().error.code).toBe('TOKEN_INVALID');
  });

  it('rejects an expired code with 401 TOKEN_EXPIRED', async () => {
    const email = nextEmail();
    const { userId } = await register(email, 'original-pass-12345');
    expect(await forgot(email)).toBe(202);
    const code = await readResetCode(userId);

    // Force the stored token past its TTL.
    await getPool().sql.unsafe(
      `UPDATE password_reset_tokens SET expires_at = NOW() - INTERVAL '1 hour' WHERE user_id = $1`,
      [userId],
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      headers: { 'content-type': 'application/json' },
      payload: { code, newPassword: NEW_PASSWORD },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<ErrorBody>().error.code).toBe('TOKEN_EXPIRED');
  });

  it('burns the code after one use — a replay is 401', async () => {
    const email = nextEmail();
    const { userId } = await register(email, 'original-pass-12345');
    expect(await forgot(email)).toBe(202);
    const code = await readResetCode(userId);

    expect(await reset(code, NEW_PASSWORD)).toBe(204);
    expect(await reset(code, 'second-attempt-pass-77')).toBe(401);
  });
});
