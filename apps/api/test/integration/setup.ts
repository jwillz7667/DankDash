/**
 * Integration-test rig for apps/api.
 *
 * Provides three things the feature tests below rely on:
 *
 *   1. `seedFixtures()` — truncates and reseeds the Postgres+PostGIS
 *      testcontainer (booted once by vitest globalSetup) with the
 *      deterministic seed defined in `@dankdash/db/seed`. Suites that
 *      mutate the DB call this in `beforeEach` so each test starts from
 *      the same clean state without paying the container boot cost.
 *
 *   2. `SEED_IDS` — the stable UUIDs the seed produces, computed via the
 *      same `stableUuid()` helper the seed uses, so the tests can address
 *      seeded dispensaries / staff / products / categories by id without
 *      reading the DB first. Keys here mirror the keys in the seed
 *      arrays (e.g. `'mpls'`, `'staff-mpls-owner'`, `'p-flower-bg-2'`).
 *
 *   3. `signTokenFor()` — mints a real RS256 access token via the
 *      AppModule-bound `JwtService`. The global JwtAuthGuard verifies the
 *      same key pair, so the token rides through `Authorization: Bearer`
 *      exactly as a production token would. The guard does NOT consult
 *      the DB for session validity, so any `{userId, sessionId, role}`
 *      triple works — for vendor routes the userId MUST correspond to a
 *      real seeded staff member because VendorContextGuard does look up
 *      `dispensary_staff`.
 */
import '../helpers/env-setup.js';
import { randomUUID } from 'node:crypto';
import { stableUuid } from '@dankdash/db';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { JwtService } from '../../src/modules/auth/jwt/jwt.service.js';
import { resetDb, seedDefault, getPool } from './db.js';

export const SEED_IDS = {
  dispensary: {
    mpls: stableUuid('dispensary', 'mpls'),
    stp: stableUuid('dispensary', 'stp'),
    mg: stableUuid('dispensary', 'mg'),
  },
  user: {
    mplsOwner: stableUuid('user', 'staff-mpls-owner'),
    mplsBudtender: stableUuid('user', 'staff-mpls-bud'),
    stpOwner: stableUuid('user', 'staff-stp-owner'),
    stpManager: stableUuid('user', 'staff-stp-mgr'),
    mgOwner: stableUuid('user', 'staff-mg-owner'),
    customer1: stableUuid('user', 'customer-1'),
  },
  product: {
    northernLights7g: stableUuid('product', 'p-flower-bg-2'),
    northernLightsPreroll: stableUuid('product', 'p-preroll-bg-1'),
    durbanPoison35g: stableUuid('product', 'p-flower-prl-1'),
    durbanPoison5Pack: stableUuid('product', 'p-preroll-prl-1'),
    sunsetSherbet: stableUuid('product', 'p-flower-bg-1'),
  },
  category: {
    flower: stableUuid('category', 'cat-flower'),
    preroll: stableUuid('category', 'cat-preroll'),
    edible: stableUuid('category', 'cat-edible'),
  },
  listing: {
    mplsNorthernLights7g: stableUuid('listing', 'mpls-p-flower-bg-2'),
    stpNorthernLights7g: stableUuid('listing', 'stp-p-flower-bg-2'),
    mplsDurban5Pack: stableUuid('listing', 'mpls-p-preroll-prl-1'),
  },
} as const;

export async function seedFixtures(): Promise<void> {
  await seedDefault();
}

export async function truncateFixtures(): Promise<void> {
  await resetDb();
}

export { getPool };

export interface TokenInput {
  readonly userId: string;
  readonly role: 'customer' | 'budtender' | 'manager' | 'owner' | 'driver' | 'admin' | 'superadmin';
  /** Optional session id. Defaults to a random UUIDv4 — the guard does not
   *  consult the DB so the value is opaque from the API's perspective. */
  readonly sessionId?: string;
}

/**
 * Mint a Bearer access token through the running app's JwtService so the
 * RS256 key pair matches what JwtAuthGuard verifies against.
 */
export function signTokenFor(app: NestFastifyApplication, input: TokenInput): string {
  const jwt = app.get(JwtService);
  return jwt.signAccessToken({
    userId: input.userId,
    sessionId: input.sessionId ?? randomUUID(),
    role: input.role,
  });
}

export function bearer(token: string): { readonly authorization: string } {
  return { authorization: `Bearer ${token}` };
}
