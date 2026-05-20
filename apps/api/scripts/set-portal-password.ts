#!/usr/bin/env node
/**
 * One-shot helper to swap a seeded user's sentinel password hash
 * (`$seed$placeholder-not-bcrypt-do-not-use-in-prod`) for a real
 * argon2id hash so the account can sign in via the vendor portal.
 *
 * Mirrors the exact two-layer construction used by
 * apps/api/src/modules/auth/password/password.service.ts:
 *
 *   preHash = HMAC-SHA256(PASSWORD_PEPPER, utf8(password))
 *   stored  = argon2id(preHash, m=64MiB, t=3, p=1, hashLength=32)
 *
 * Local dev only. Production password resets go through the auth
 * controller's reset flow, never this script.
 *
 * Usage:
 *   tsx apps/api/scripts/set-portal-password.ts <email> <plaintext>
 */
import { createHmac } from 'node:crypto';
import { createPool } from '@dankdash/db';
import argon2 from 'argon2';
import pino from 'pino';

async function main(): Promise<void> {
  const [, , email, plaintext] = process.argv;
  if (email === undefined || plaintext === undefined) {
    process.stderr.write('usage: set-portal-password <email> <plaintext>\n');
    process.exit(2);
  }

  const databaseUrl = process.env['DATABASE_URL'];
  const pepper = process.env['PASSWORD_PEPPER'];
  if (databaseUrl === undefined || databaseUrl === '') {
    process.stderr.write('DATABASE_URL is required\n');
    process.exit(2);
  }
  if (pepper === undefined || pepper.length < 32) {
    process.stderr.write('PASSWORD_PEPPER must be set and at least 32 bytes\n');
    process.exit(2);
  }

  const preHash = createHmac('sha256', Buffer.from(pepper, 'utf8'))
    .update(Buffer.from(plaintext, 'utf8'))
    .digest();

  const stored = await argon2.hash(preHash, {
    type: argon2.argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
    hashLength: 32,
  });

  const logger = pino({ level: 'info' });
  const pool = createPool({ databaseUrl, logger });
  try {
    const rows = await pool.sql<{ id: string; email: string; role: string }[]>`
      UPDATE users
         SET password_hash = ${stored}
       WHERE email = ${email}
       RETURNING id, email, role
    `;
    if (rows.length === 0) {
      process.stderr.write(`no user found with email ${email}\n`);
      process.exit(1);
    }
    process.stdout.write(`updated ${String(rows.length)} user(s): ${JSON.stringify(rows)}\n`);
  } finally {
    await pool.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`set-portal-password failed: ${String(err)}\n`);
  process.exit(1);
});
