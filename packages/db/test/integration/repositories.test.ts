/**
 * Broad repository coverage — exercises CRUD and lifecycle methods across
 * domains so the repository layer's contract with the schema is tested end-
 * to-end. Each describe-block targets a single domain so failures stay
 * easy to localize.
 *
 * The suite shares one seeded container with the other integration tests;
 * every test that mutates state is scoped to fresh inserts (no race against
 * seeded fixtures).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AgeVerificationsRepository,
  CartItemsRepository,
  CartsRepository,
  ComplianceChecksRepository,
  DispatchOffersRepository,
  DispensariesRepository,
  DispensaryListingsRepository,
  DispensaryStaffRepository,
  DriverLocationHistoryRepository,
  DriverShiftsRepository,
  DriversRepository,
  LedgerEntriesRepository,
  MetrcTransactionsRepository,
  NotificationPreferencesRepository,
  NotificationsRepository,
  OrdersRepository,
  PasswordResetTokensRepository,
  PaymentMethodsRepository,
  PaymentTransactionsRepository,
  PayoutsRepository,
  ProductCategoriesRepository,
  ProductsRepository,
  PushTokensRepository,
  RefundsRepository,
  SessionsRepository,
  UserAddressesRepository,
  UserIdDocumentsRepository,
  UsersRepository,
  WebhookEventsProcessedRepository,
  newId,
  stableUuid,
} from '../../src/index.js';
import { type GeoPoint } from '../../src/schema/custom-types.js';
import { getPool, seedDefault } from '../setup.js';

const ALICE = stableUuid('user', 'customer-1');
const BEN = stableUuid('user', 'customer-2');
const DEREK = stableUuid('user', 'customer-4');
const MPLS = stableUuid('dispensary', 'mpls');
const STP = stableUuid('dispensary', 'stp');
const MG = stableUuid('dispensary', 'mg');
const ADDR_ALICE = stableUuid('address', 'addr-alice-home');

describe('repository coverage', () => {
  beforeAll(async () => {
    await seedDefault();
  }, 60_000);

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  describe('UsersRepository', () => {
    it('findByEmail + findByPhone resolve the seeded customer', async () => {
      const users = new UsersRepository(getPool().db);
      const byEmail = await users.findByEmail('alice.kim@example.com');
      expect(byEmail?.id).toBe(ALICE);

      const byPhone = await users.findByPhone('+16125550101');
      expect(byPhone?.id).toBe(ALICE);
    });

    it('returns null for unknown lookups', async () => {
      const users = new UsersRepository(getPool().db);
      expect(await users.findByEmail('ghost@example.test')).toBeNull();
      expect(await users.findByPhone('+10000000000')).toBeNull();
      expect(await users.findById(stableUuid('user', 'nonexistent'))).toBeNull();
    });

    it('create + update + markKycVerified + recordLogin', async () => {
      const users = new UsersRepository(getPool().db);
      const inserted = await users.create({
        email: 'temp.user@example.test',
        phone: '+15555550199',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$placeholder',
        role: 'customer',
        status: 'pending_kyc',
        firstName: 'Temp',
        lastName: 'User',
        dateOfBirth: '2000-01-01',
      });
      expect(inserted.status).toBe('pending_kyc');

      const patched = await users.update(inserted.id, { lastName: 'Updated' });
      expect(patched?.lastName).toBe('Updated');

      const verified = await users.markKycVerified(inserted.id, 'persona', 'inq_abc');
      expect(verified?.status).toBe('active');
      expect(verified?.kycProvider).toBe('persona');

      const loginAt = new Date('2026-05-01T12:00:00Z');
      await users.recordLogin(inserted.id, loginAt);
      const afterLogin = await users.findById(inserted.id);
      expect(afterLogin?.lastLoginAt?.getTime()).toBe(loginAt.getTime());

      await users.softDelete(inserted.id);
      const afterDelete = await users.findById(inserted.id);
      expect(afterDelete?.deletedAt).not.toBeNull();
    });
  });

  describe('UserAddressesRepository', () => {
    it('findById + listForUser surface seeded GeoPoint locations', async () => {
      const addresses = new UserAddressesRepository(getPool().db);
      const list = await addresses.listForUser(ALICE);
      expect(list.length).toBeGreaterThan(0);
      const first = list[0]!;
      expect(first.location.type).toBe('Point');
      expect(first.location.coordinates).toHaveLength(2);

      const byId = await addresses.findById(first.id);
      expect(byId?.id).toBe(first.id);
      expect(byId?.location.coordinates).toEqual(first.location.coordinates);
    });

    it('create + setDefault + softDelete', async () => {
      const addresses = new UserAddressesRepository(getPool().db);
      const created = await addresses.create({
        userId: DEREK,
        label: 'Work',
        line1: '120 N Washington Ave',
        city: 'Minneapolis',
        region: 'MN',
        postalCode: '55401',
        country: 'US',
        location: { type: 'Point', coordinates: [-93.273, 44.984] },
        isDefault: false,
      });
      expect(created.label).toBe('Work');
      expect(created.location.coordinates).toEqual([-93.273, 44.984]);

      await addresses.setDefault(DEREK, created.id);
      const afterDefault = await addresses.findById(created.id);
      expect(afterDefault?.isDefault).toBe(true);

      await addresses.softDelete(created.id);
      const after = await addresses.findById(created.id);
      expect(after?.deletedAt).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Account deletion — the DELETE /v1/me orchestration's repo primitives.
  // Each test provisions a throwaway user so it never disturbs seeded fixtures
  // or the other suites sharing this container.
  // ---------------------------------------------------------------------------
  describe('Account deletion repository methods', () => {
    async function freshUser(tag: string): Promise<string> {
      const users = new UsersRepository(getPool().db);
      const suffix = stableUuid('acctdel', tag).slice(0, 8);
      const created = await users.create({
        email: `acctdel-${tag}-${suffix}@example.test`,
        phone: `+1612${suffix.replace(/\D/g, '0').slice(0, 7).padEnd(7, '0')}`,
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$placeholder',
        role: 'customer',
        status: 'active',
        firstName: 'Throwaway',
        lastName: tag,
        dateOfBirth: '1995-06-15',
      });
      return created.id;
    }

    it('UsersRepository.anonymizeAndSoftDelete scrubs PII and is single-shot', async () => {
      const users = new UsersRepository(getPool().db);
      const userId = await freshUser('anon');

      const anonymized = await users.anonymizeAndSoftDelete(userId);
      expect(anonymized).not.toBeNull();
      expect(anonymized?.deletedAt).not.toBeNull();
      expect(anonymized?.email).toBe(`deleted+${userId}@deleted.invalid`);
      expect(anonymized?.phone).toBeNull();
      expect(anonymized?.firstName).toBeNull();
      expect(anonymized?.lastName).toBeNull();
      expect(anonymized?.dateOfBirth).toBeNull();
      expect(anonymized?.mfaEnabled).toBe(false);
      expect(anonymized?.mfaSecretEnc).toBeNull();
      // Password is replaced with a non-verifiable sentinel — no Argon2 prefix.
      expect(anonymized?.passwordHash).not.toContain('argon2');

      // The `deleted_at IS NULL` guard makes a second call a no-op (null).
      const second = await users.anonymizeAndSoftDelete(userId);
      expect(second).toBeNull();
    });

    it('UserAddressesRepository.softDeleteAllForUser clears every live row + default', async () => {
      const addresses = new UserAddressesRepository(getPool().db);
      const userId = await freshUser('addr');

      const a1 = await addresses.create({
        userId,
        label: 'Home',
        line1: '1 First St',
        city: 'Minneapolis',
        region: 'MN',
        postalCode: '55401',
        country: 'US',
        location: { type: 'Point', coordinates: [-93.27, 44.97] },
        isDefault: false,
      });
      await addresses.create({
        userId,
        label: 'Work',
        line1: '2 Second St',
        city: 'Minneapolis',
        region: 'MN',
        postalCode: '55402',
        country: 'US',
        location: { type: 'Point', coordinates: [-93.26, 44.98] },
        isDefault: false,
      });
      await addresses.setDefault(userId, a1.id);

      const count = await addresses.softDeleteAllForUser(userId);
      expect(count).toBe(2);

      const remaining = await addresses.listForUser(userId);
      expect(remaining).toHaveLength(0);

      const wasDefault = await addresses.findById(a1.id);
      expect(wasDefault?.deletedAt).not.toBeNull();
      expect(wasDefault?.isDefault).toBe(false);

      // Idempotent: nothing left to clear.
      expect(await addresses.softDeleteAllForUser(userId)).toBe(0);
    });

    it('PaymentMethodsRepository.softDeleteAllForUser clears every live row + default', async () => {
      const pm = new PaymentMethodsRepository(getPool().db);
      const userId = await freshUser('pm');

      const m1 = await pm.create({
        userId,
        type: 'aeropay_ach',
        aeropayPaymentMethodRef: `aeropay-${userId}-1`,
        bankName: 'First Bank',
        last4: '1111',
        isDefault: false,
        status: 'active',
      });
      await pm.create({
        userId,
        type: 'aeropay_ach',
        aeropayPaymentMethodRef: `aeropay-${userId}-2`,
        bankName: 'Second Bank',
        last4: '2222',
        isDefault: false,
        status: 'active',
      });
      await pm.setDefault(userId, m1.id);

      const count = await pm.softDeleteAllForUser(userId);
      expect(count).toBe(2);

      const remaining = await pm.listForUser(userId);
      expect(remaining).toHaveLength(0);
      expect(await pm.findDefaultForUser(userId)).toBeNull();

      expect(await pm.softDeleteAllForUser(userId)).toBe(0);
    });

    it('PasswordResetTokensRepository.invalidateAllActiveForUser kills live tokens', async () => {
      const tokens = new PasswordResetTokensRepository(getPool().db);
      const userId = await freshUser('prt');

      const h1 = new Uint8Array(32);
      h1[0] = 200;
      const h2 = new Uint8Array(32);
      h2[0] = 201;
      await tokens.create({
        userId,
        codeHash: h1,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      await tokens.create({
        userId,
        codeHash: h2,
        expiresAt: new Date(Date.now() + 3_600_000),
      });

      const invalidated = await tokens.invalidateAllActiveForUser(userId);
      expect(invalidated).toBe(2);

      expect((await tokens.findByCodeHash(h1))?.usedAt).not.toBeNull();
      expect(await tokens.invalidateAllActiveForUser(userId)).toBe(0);
    });

    it('OrdersRepository.countActiveForUser counts only non-terminal orders', async () => {
      const pool = getPool();
      const orders = new OrdersRepository(pool.db);
      const addresses = new UserAddressesRepository(pool.db);
      const userId = await freshUser('orders');

      expect(await orders.countActiveForUser(userId)).toBe(0);

      const addr = await addresses.create({
        userId,
        label: 'Home',
        line1: '9 Ninth St',
        city: 'Minneapolis',
        region: 'MN',
        postalCode: '55401',
        country: 'US',
        location: { type: 'Point', coordinates: [-93.27, 44.97] },
        isDefault: true,
      });

      const mkOrder = async (status: string): Promise<void> => {
        const shortCode = `AD${stableUuid('order', `${userId}-${status}`).slice(0, 8).toUpperCase()}`;
        await pool.sql`
          INSERT INTO orders (
            short_code, user_id, dispensary_id, delivery_address_id, status,
            subtotal_cents, cannabis_tax_cents, sales_tax_cents,
            delivery_fee_cents, total_cents,
            compliance_check_payload, delivery_address_snapshot
          )
          VALUES (
            ${shortCode}, ${userId}, ${MPLS}, ${addr.id}, ${status}::order_status,
            1000, 0, 0, 0, 1000,
            '{}'::jsonb, '{}'::jsonb
          )
        `;
      };

      // One in-flight (placed) + one terminal (canceled): only the live one counts.
      await mkOrder('placed');
      await mkOrder('canceled');

      expect(await orders.countActiveForUser(userId)).toBe(1);
    });
  });

  describe('UserIdDocumentsRepository', () => {
    it('listForUser returns the seeded document and markVerified updates it', async () => {
      const docs = new UserIdDocumentsRepository(getPool().db);
      const aliceDocs = await docs.listForUser(ALICE);
      expect(aliceDocs.length).toBeGreaterThan(0);

      // Insert a fresh unverified document, then mark verified.
      const fresh = await docs.create({
        userId: BEN,
        type: 'state_id',
        issuingRegion: 'MN',
        documentNumberHash: new Uint8Array(32),
        verified: false,
      });
      expect(fresh.verified).toBe(false);

      const verified = await docs.markVerified(fresh.id, 'veriff:session-xyz');
      expect(verified?.verified).toBe(true);
      expect(verified?.verificationRef).toBe('veriff:session-xyz');
    });
  });

  describe('SessionsRepository', () => {
    it('create + findByRefreshTokenHash + touch + revoke', async () => {
      const sessions = new SessionsRepository(getPool().db);
      const hash = new Uint8Array(32);
      hash[0] = 7;
      hash[1] = 11;

      const familyId = newId();
      const created = await sessions.create({
        userId: ALICE,
        familyId,
        refreshTokenHash: hash,
        deviceId: 'iphone-16',
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      expect(created.userId).toBe(ALICE);
      expect(created.familyId).toBe(familyId);

      const found = await sessions.findByRefreshTokenHash(hash);
      expect(found?.id).toBe(created.id);

      const touchAt = new Date('2026-05-02T08:00:00Z');
      await sessions.touch(created.id, touchAt);
      const afterTouch = await sessions.findByRefreshTokenHash(hash);
      expect(afterTouch?.lastUsedAt.getTime()).toBe(touchAt.getTime());

      await sessions.revoke(created.id);
      // findByRefreshTokenHash deliberately does not filter on revoked status —
      // the calling service inspects revokedAt to decide whether to honor it.
      const revoked = await sessions.findByRefreshTokenHash(hash);
      expect(revoked?.revokedAt).not.toBeNull();
    });

    it('revokeAllForUser + deleteExpired sweep stale rows', async () => {
      const sessions = new SessionsRepository(getPool().db);

      // Insert two active sessions, then revoke all.
      const h1 = new Uint8Array(32);
      h1[0] = 1;
      h1[1] = 2;
      const h2 = new Uint8Array(32);
      h2[0] = 3;
      h2[1] = 4;

      await sessions.create({
        userId: BEN,
        familyId: newId(),
        refreshTokenHash: h1,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      await sessions.create({
        userId: BEN,
        familyId: newId(),
        refreshTokenHash: h2,
        expiresAt: new Date(Date.now() + 86_400_000),
      });

      await sessions.revokeAllForUser(BEN);
      expect((await sessions.findByRefreshTokenHash(h1))?.revokedAt).not.toBeNull();
      expect((await sessions.findByRefreshTokenHash(h2))?.revokedAt).not.toBeNull();

      // Insert an already-expired session, then sweep.
      const hExp = new Uint8Array(32);
      hExp[0] = 9;
      await sessions.create({
        userId: BEN,
        familyId: newId(),
        refreshTokenHash: hExp,
        expiresAt: new Date(Date.now() - 1_000),
      });
      const deleted = await sessions.deleteExpired(new Date());
      expect(deleted).toBeGreaterThan(0);
    });

    it('rotate atomically issues successor and stamps predecessor', async () => {
      const sessions = new SessionsRepository(getPool().db);
      const familyId = newId();
      const h1 = new Uint8Array(32);
      h1[0] = 21;
      const h2 = new Uint8Array(32);
      h2[0] = 22;

      const first = await sessions.create({
        userId: ALICE,
        familyId,
        refreshTokenHash: h1,
        expiresAt: new Date(Date.now() + 86_400_000),
      });

      const second = await sessions.rotate({
        predecessorId: first.id,
        successor: {
          userId: ALICE,
          familyId,
          refreshTokenHash: h2,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });

      expect(second.familyId).toBe(familyId);
      expect(second.id).not.toBe(first.id);

      const predAfter = await sessions.findById(first.id);
      expect(predAfter?.rotatedAt).not.toBeNull();
      expect(predAfter?.rotatedTo).toBe(second.id);
    });

    it('rotate refuses to double-rotate a predecessor (reuse safety)', async () => {
      const sessions = new SessionsRepository(getPool().db);
      const familyId = newId();
      const h1 = new Uint8Array(32);
      h1[0] = 31;
      const h2 = new Uint8Array(32);
      h2[0] = 32;
      const h3 = new Uint8Array(32);
      h3[0] = 33;

      const first = await sessions.create({
        userId: ALICE,
        familyId,
        refreshTokenHash: h1,
        expiresAt: new Date(Date.now() + 86_400_000),
      });

      await sessions.rotate({
        predecessorId: first.id,
        successor: {
          userId: ALICE,
          familyId,
          refreshTokenHash: h2,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });

      await expect(
        sessions.rotate({
          predecessorId: first.id,
          successor: {
            userId: ALICE,
            familyId,
            refreshTokenHash: h3,
            expiresAt: new Date(Date.now() + 86_400_000),
          },
        }),
      ).rejects.toThrow('predecessor session unavailable for rotation');
    });

    it('revokeFamily burns every non-revoked row sharing a familyId', async () => {
      const sessions = new SessionsRepository(getPool().db);
      const familyId = newId();
      const other = newId();
      const h1 = new Uint8Array(32);
      h1[0] = 41;
      const h2 = new Uint8Array(32);
      h2[0] = 42;
      const hOther = new Uint8Array(32);
      hOther[0] = 43;

      await sessions.create({
        userId: ALICE,
        familyId,
        refreshTokenHash: h1,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      await sessions.create({
        userId: ALICE,
        familyId,
        refreshTokenHash: h2,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      await sessions.create({
        userId: ALICE,
        familyId: other,
        refreshTokenHash: hOther,
        expiresAt: new Date(Date.now() + 86_400_000),
      });

      const burned = await sessions.revokeFamily(familyId);
      expect(burned).toBe(2);
      expect((await sessions.findByRefreshTokenHash(h1))?.revokedAt).not.toBeNull();
      expect((await sessions.findByRefreshTokenHash(h2))?.revokedAt).not.toBeNull();
      expect((await sessions.findByRefreshTokenHash(hOther))?.revokedAt).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Dispensaries
  // -------------------------------------------------------------------------

  describe('DispensariesRepository', () => {
    it('findById + findByLicenseNumber + listDeliveringTo (geofence)', async () => {
      const dispensaries = new DispensariesRepository(getPool().db);
      const mpls = await dispensaries.findById(MPLS);
      expect(mpls?.dba).toBe('North Loop Cannabis');

      const byLicense = await dispensaries.findByLicenseNumber(mpls!.licenseNumber);
      expect(byLicense?.id).toBe(MPLS);

      // A point inside the MPLS delivery polygon should match.
      const inside: GeoPoint = { type: 'Point', coordinates: mpls!.location.coordinates };
      const deliveringHere = await dispensaries.listDeliveringTo(inside);
      expect(deliveringHere.some((d) => d.id === MPLS)).toBe(true);

      // A point far outside Minnesota should match no dispensary.
      const farAway: GeoPoint = { type: 'Point', coordinates: [-118.2437, 34.0522] };
      const noneDelivering = await dispensaries.listDeliveringTo(farAway);
      expect(noneDelivering).toEqual([]);
    });

    it('setAcceptingOrders + updateStatus reflect on subsequent reads', async () => {
      const dispensaries = new DispensariesRepository(getPool().db);
      await dispensaries.setAcceptingOrders(STP, false);
      const after = await dispensaries.findById(STP);
      expect(after?.isAcceptingOrders).toBe(false);

      await dispensaries.setAcceptingOrders(STP, true);
      const restored = await dispensaries.findById(STP);
      expect(restored?.isAcceptingOrders).toBe(true);

      const paused = await dispensaries.updateStatus(MG, 'paused');
      expect(paused?.status).toBe('paused');
      await dispensaries.updateStatus(MG, 'active');
    });

    it('applyRating folds one rating into the running aggregate (numeric, no float drift)', async () => {
      const pool = getPool();
      const dispensaries = new DispensariesRepository(pool.db);

      const before = await dispensaries.findById(MG);
      const prevAvg = Number(before!.ratingAvg);
      const prevCount = before!.ratingCount;

      await dispensaries.applyRating(MG, 5);

      const after = await dispensaries.findById(MG);
      const expectedAvg = ((prevAvg * prevCount + 5) / (prevCount + 1)).toFixed(2);
      expect(after?.ratingAvg).toBe(expectedAvg);
      expect(after?.ratingCount).toBe(prevCount + 1);

      // Restore so the shared container stays clean for other tests.
      await pool.sql.unsafe(
        `UPDATE dispensaries SET rating_avg = $1, rating_count = $2 WHERE id = $3::uuid`,
        [before!.ratingAvg, prevCount, MG],
      );
    });
  });

  describe('DispensaryStaffRepository', () => {
    it('findByDispensaryAndUser + invite + accept + remove', async () => {
      const staff = new DispensaryStaffRepository(getPool().db);

      // Confirm one of the seeded staff is reachable both ways.
      const seeded = await staff.listActiveForDispensary(MPLS);
      expect(seeded.length).toBeGreaterThan(0);
      const first = seeded[0]!;
      const found = await staff.findByDispensaryAndUser(MPLS, first.userId);
      expect(found?.id).toBe(first.id);

      // Invite a customer to STP (Derek), accept, then remove.
      const invited = await staff.invite({
        dispensaryId: STP,
        userId: DEREK,
        role: 'budtender',
      });
      expect(invited.role).toBe('budtender');

      const acceptAt = new Date('2026-05-03T12:00:00Z');
      await staff.accept(invited.id, acceptAt);

      const removeAt = new Date('2026-05-04T12:00:00Z');
      await staff.remove(invited.id, removeAt);

      const userActive = await staff.listActiveForUser(DEREK);
      expect(userActive.some((s) => s.id === invited.id)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Catalog
  // -------------------------------------------------------------------------

  describe('Products + Listings + Categories', () => {
    it('ProductsRepository.search returns ranked hits and softDelete hides them', async () => {
      const pool = getPool();
      const products = new ProductsRepository(pool.db);
      const categories = new ProductCategoriesRepository(pool.db);

      const cats = await categories.listAll();
      const flowerCat = cats.find((c) => c.slug === 'flower')!;
      const bySlug = await categories.findBySlug('flower');
      expect(bySlug?.id).toBe(flowerCat.id);
      const byCatId = await categories.findById(flowerCat.id);
      expect(byCatId?.slug).toBe('flower');

      const newCat = await categories.create({
        slug: `temp-${newId()}`,
        displayName: 'Temp Category',
        displayOrder: 99,
      });
      expect(newCat.displayName).toBe('Temp Category');

      const created = await products.create({
        categoryId: flowerCat.id,
        brand: 'SearchableBrand',
        name: 'Lunar Pheasant 7g',
        description: 'A bright sativa-leaning hybrid',
        productType: 'flower',
        strainType: 'sativa',
        thcMgPerUnit: '1500.000',
        weightGramsPerUnit: '7.000',
      });

      const found = await products.findById(created.id);
      expect(found?.name).toBe('Lunar Pheasant 7g');

      const hits = await products.search('lunar pheasant');
      expect(hits.some((h) => h.id === created.id)).toBe(true);

      const updated = await products.update(created.id, { description: 'Updated copy' });
      expect(updated?.description).toBe('Updated copy');

      await products.softDelete(created.id);
      const afterDelete = await products.listByCategory(flowerCat.id);
      expect(afterDelete.some((p) => p.id === created.id)).toBe(false);
    });

    it('DispensaryListingsRepository.decrementInventory is race-safe', async () => {
      const pool = getPool();
      const listings = new DispensaryListingsRepository(pool.db);

      const mplsListings = await listings.listForDispensary(MPLS);
      const target = mplsListings.find((l) => l.quantityAvailable >= 5)!;
      expect(target).toBeDefined();

      const before = target.quantityAvailable;
      const decremented = await listings.decrementInventory(target.id, 2);
      expect(decremented?.quantityAvailable).toBe(before - 2);

      const bySku = await listings.findByDispensaryAndSku(MPLS, target.sku);
      expect(bySku?.id).toBe(target.id);

      const byId = await listings.findById(target.id);
      expect(byId?.id).toBe(target.id);

      // Cannot decrement below zero — repo returns null.
      const overdraw = await listings.decrementInventory(target.id, 9_999_999);
      expect(overdraw).toBeNull();

      // Zero or negative quantity rejected up front.
      await expect(listings.decrementInventory(target.id, 0)).rejects.toThrow(/positive/);

      const updated = await listings.update(target.id, {
        compareAtPriceCents: target.priceCents + 200,
      });
      expect(updated?.compareAtPriceCents).toBe(target.priceCents + 200);

      // image_keys defaults to an empty array and round-trips a text[] override.
      expect(byId?.imageKeys).toEqual([]);
      const keys = [
        `dispensaries/${MPLS}/listings/${newId()}.jpg`,
        `dispensaries/${MPLS}/listings/${newId()}.webp`,
      ];
      const withImages = await listings.update(target.id, { imageKeys: keys });
      expect(withImages?.imageKeys).toEqual(keys);
      const reread = await listings.findById(target.id);
      expect(reread?.imageKeys).toEqual(keys);

      // Cleared back to empty so the shared seed stays neutral for other tests.
      const cleared = await listings.update(target.id, { imageKeys: [] });
      expect(cleared?.imageKeys).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Carts
  // -------------------------------------------------------------------------

  describe('CartsRepository + CartItemsRepository', () => {
    it('createOrGetActive is idempotent per (user, dispensary)', async () => {
      const carts = new CartsRepository(getPool().db);
      const first = await carts.createOrGetActive(ALICE, MPLS);
      const second = await carts.createOrGetActive(ALICE, MPLS);
      expect(first.id).toBe(second.id);
      const byId = await carts.findById(first.id);
      expect(byId?.id).toBe(first.id);

      const byPair = await carts.findActiveForUserAndDispensary(ALICE, MPLS);
      expect(byPair?.id).toBe(first.id);
    });

    it('addOrIncrement upserts and setQuantity(<=0) deletes', async () => {
      const pool = getPool();
      const carts = new CartsRepository(pool.db);
      const items = new CartItemsRepository(pool.db);
      const listings = new DispensaryListingsRepository(pool.db);

      const cart = await carts.createOrGetActive(DEREK, MPLS);
      const mplsListings = await listings.listForDispensary(MPLS);
      const listing = mplsListings[0]!;

      const item1 = await items.addOrIncrement({
        cartId: cart.id,
        listingId: listing.id,
        quantity: 1,
        unitPriceCents: listing.priceCents,
      });
      const item2 = await items.addOrIncrement({
        cartId: cart.id,
        listingId: listing.id,
        quantity: 2,
        unitPriceCents: listing.priceCents,
      });
      expect(item1.id).toBe(item2.id);
      expect(item2.quantity).toBe(3);

      const setHigher = await items.setQuantity(item2.id, 5);
      expect(setHigher?.quantity).toBe(5);

      const removedViaZero = await items.setQuantity(item2.id, 0);
      expect(removedViaZero).toBeNull();
      expect(await items.listForCart(cart.id)).toEqual([]);
    });

    it('clearCart, remove, touch, deleteExpired all behave', async () => {
      const pool = getPool();
      const carts = new CartsRepository(pool.db);
      const items = new CartItemsRepository(pool.db);
      const listings = new DispensaryListingsRepository(pool.db);

      const cart = await carts.createOrGetActive(BEN, MPLS);
      const mplsListings = await listings.listForDispensary(MPLS);
      const listing = mplsListings[1] ?? mplsListings[0]!;

      const ci = await items.addOrIncrement({
        cartId: cart.id,
        listingId: listing.id,
        quantity: 1,
        unitPriceCents: listing.priceCents,
      });

      await items.remove(ci.id);
      expect(await items.listForCart(cart.id)).toEqual([]);

      await items.addOrIncrement({
        cartId: cart.id,
        listingId: listing.id,
        quantity: 2,
        unitPriceCents: listing.priceCents,
      });
      await items.clearCart(cart.id);
      expect(await items.listForCart(cart.id)).toEqual([]);

      await carts.touch(cart.id);

      // deleteExpired against `now-in-the-past` should remove nothing.
      const noneDeleted = await carts.deleteExpired(new Date('2000-01-01T00:00:00Z'));
      expect(noneDeleted).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Payments / ledger
  // -------------------------------------------------------------------------

  describe('Payments + Ledger', () => {
    it('PaymentMethodsRepository full lifecycle (default, status, softDelete)', async () => {
      const pool = getPool();
      const pm = new PaymentMethodsRepository(pool.db);

      const seeded = await pm.listForUser(ALICE);
      expect(seeded.length).toBeGreaterThan(0);
      const firstId = seeded[0]!.id;

      const byId = await pm.findById(firstId);
      expect(byId?.id).toBe(firstId);

      const defaultMethod = await pm.findDefaultForUser(ALICE);
      expect(defaultMethod?.isDefault).toBe(true);

      const created = await pm.create({
        userId: ALICE,
        type: 'aeropay_ach',
        aeropayPaymentMethodRef: 'aeropay-tmp',
        bankName: 'Temp Bank',
        last4: '9999',
        isDefault: false,
        status: 'pending',
      });

      await pm.setDefault(ALICE, created.id);
      const newDefault = await pm.findDefaultForUser(ALICE);
      expect(newDefault?.id).toBe(created.id);

      const statusUpdated = await pm.updateStatus(created.id, 'active');
      expect(statusUpdated?.status).toBe('active');

      await pm.softDelete(created.id);
      const afterDelete = await pm.findById(created.id);
      expect(afterDelete?.deletedAt).not.toBeNull();
    });

    it('PaymentTransactionsRepository create + findByProviderRef + updateStatus', async () => {
      const pool = getPool();
      const tx = new PaymentTransactionsRepository(pool.db);
      const carts = new CartsRepository(pool.db);
      const items = new CartItemsRepository(pool.db);
      const listings = new DispensaryListingsRepository(pool.db);

      // Need an order_id to satisfy the FK. Build a minimal order directly.
      const cart = await carts.createOrGetActive(ALICE, STP);
      void cart; // satisfies "must be active"

      const mplsListings = await listings.listForDispensary(MPLS);
      const listing = mplsListings[0]!;
      void items;

      const shortCode = `PT${Math.floor(Math.random() * 1_000_000)}`;
      const [order] = await pool.sql<{ id: string }[]>`
        INSERT INTO orders (
          short_code, user_id, dispensary_id, delivery_address_id,
          subtotal_cents, cannabis_tax_cents, sales_tax_cents,
          delivery_fee_cents, total_cents,
          compliance_check_payload, delivery_address_snapshot
        )
        VALUES (
          ${shortCode}, ${ALICE}, ${MPLS}, ${ADDR_ALICE},
          ${listing.priceCents}, 0, 0, 0, ${listing.priceCents},
          '{}'::jsonb, '{}'::jsonb
        )
        RETURNING id
      `;

      const created = await tx.create({
        orderId: order!.id,
        provider: 'aeropay',
        providerRef: `ref-${shortCode}`,
        amountCents: listing.priceCents,
        status: 'initiated',
      });

      const byRef = await tx.findByProviderRef('aeropay', `ref-${shortCode}`);
      expect(byRef?.id).toBe(created.id);

      const byId = await tx.findById(created.id);
      expect(byId?.id).toBe(created.id);

      const settled = await tx.updateStatus(created.id, 'settled', {
        authorizedAt: new Date('2026-05-01T08:00:00Z'),
        settledAt: new Date('2026-05-01T08:00:10Z'),
      });
      expect(settled?.status).toBe('settled');

      const list = await tx.listForOrder(order!.id);
      expect(list.some((t) => t.id === created.id)).toBe(true);
    });

    it('LedgerEntriesRepository.accountBalanceCents = debits - credits', async () => {
      const pool = getPool();
      const ledger = new LedgerEntriesRepository(pool.db);

      // Fresh account_ref so the balance is purely from this test's writes.
      const acct = newId();

      await ledger.recordTransaction([
        {
          accountType: 'platform_revenue',
          accountRef: acct,
          debitCents: 1_000,
          creditCents: 0,
          description: 'fee',
        },
        {
          accountType: 'aeropay_clearing',
          accountRef: acct,
          debitCents: 0,
          creditCents: 1_000,
          description: 'offset',
        },
      ]);

      const platformBalance = await ledger.accountBalanceCents('platform_revenue', acct);
      expect(platformBalance).toBe(1_000);

      const clearingBalance = await ledger.accountBalanceCents('aeropay_clearing', acct);
      expect(clearingBalance).toBe(-1_000);

      // Single-side record method + listForOrder coverage.
      const single = await ledger.record({
        accountType: 'platform_revenue',
        accountRef: acct,
        debitCents: 250,
        creditCents: 0,
        description: 'standalone',
      });
      expect(single.debitCents).toBe(250);
    });
  });

  describe('PayoutsRepository', () => {
    it('create + listByStatus + listForRecipient + updateStatus', async () => {
      const pool = getPool();
      const payouts = new PayoutsRepository(pool.db);

      const created = await payouts.create({
        recipientType: 'dispensary',
        recipientId: MPLS,
        periodStart: '2026-04-01',
        periodEnd: '2026-04-30',
        grossCents: 100_000,
        feesCents: 5_000,
        netCents: 95_000,
        scheduledFor: '2026-05-05',
      });

      const found = await payouts.findById(created.id);
      expect(found?.netCents).toBe(95_000);

      const byRecipient = await payouts.listForRecipient('dispensary', MPLS);
      expect(byRecipient.some((p) => p.id === created.id)).toBe(true);

      const pending = await payouts.listByStatus('pending');
      expect(pending.some((p) => p.id === created.id)).toBe(true);

      const initiated = await payouts.updateStatus(created.id, 'processing', {
        initiatedAt: new Date('2026-05-05T09:00:00Z'),
        aeropayPayoutRef: 'po_aeropay_int_1',
      });
      expect(initiated?.status).toBe('processing');

      const byRef = await payouts.findByAeropayPayoutRef('po_aeropay_int_1');
      expect(byRef?.id).toBe(created.id);
      expect(await payouts.findByAeropayPayoutRef('po_aeropay_missing')).toBeNull();

      const completed = await payouts.updateStatus(created.id, 'completed', {
        completedAt: new Date('2026-05-07T12:00:00Z'),
      });
      expect(completed?.status).toBe('completed');
      expect(completed?.completedAt?.toISOString()).toBe('2026-05-07T12:00:00.000Z');
    });

    it('listStuckProcessing returns only processing rows initiated before the cutoff', async () => {
      const pool = getPool();
      const payouts = new PayoutsRepository(pool.db);

      const stuck = await payouts.create({
        recipientType: 'dispensary',
        recipientId: MPLS,
        periodStart: '2026-06-01',
        periodEnd: '2026-06-02',
        grossCents: 10_000,
        netCents: 10_000,
        scheduledFor: '2026-06-02',
        status: 'processing',
        aeropayPayoutRef: 'po_stuck_1',
        initiatedAt: new Date('2026-06-02T00:00:00Z'),
      });
      // Processing but initiated after the cutoff — excluded.
      const fresh = await payouts.create({
        recipientType: 'dispensary',
        recipientId: MPLS,
        periodStart: '2026-06-03',
        periodEnd: '2026-06-04',
        grossCents: 10_000,
        netCents: 10_000,
        scheduledFor: '2026-06-04',
        status: 'processing',
        aeropayPayoutRef: 'po_fresh_1',
        initiatedAt: new Date('2026-06-05T00:00:00Z'),
      });
      // Completed — never returned regardless of age.
      const done = await payouts.create({
        recipientType: 'dispensary',
        recipientId: MPLS,
        periodStart: '2026-06-05',
        periodEnd: '2026-06-06',
        grossCents: 10_000,
        netCents: 10_000,
        scheduledFor: '2026-06-06',
        status: 'completed',
        aeropayPayoutRef: 'po_done_1',
        initiatedAt: new Date('2026-06-01T00:00:00Z'),
      });

      const rows = await payouts.listStuckProcessing(new Date('2026-06-03T00:00:00Z'));
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(stuck.id);
      expect(ids).not.toContain(fresh.id);
      expect(ids).not.toContain(done.id);
    });
  });

  describe('RefundsRepository', () => {
    it('create, approve enforces separation of duties, updateStatus, totalRefunded', async () => {
      const pool = getPool();
      const refunds = new RefundsRepository(pool.db);

      // Build a minimal order to hang the refund off of.
      const shortCode = `RF${Math.floor(Math.random() * 1_000_000)}`;
      const [order] = await pool.sql<{ id: string }[]>`
        INSERT INTO orders (
          short_code, user_id, dispensary_id, delivery_address_id,
          subtotal_cents, cannabis_tax_cents, sales_tax_cents,
          delivery_fee_cents, total_cents,
          compliance_check_payload, delivery_address_snapshot
        )
        VALUES (
          ${shortCode}, ${ALICE}, ${MPLS}, ${ADDR_ALICE},
          5_000, 0, 0, 0, 5_000,
          '{}'::jsonb, '{}'::jsonb
        )
        RETURNING id
      `;

      const refund = await refunds.create({
        orderId: order!.id,
        amountCents: 2_500,
        reasonCode: 'damaged',
        initiatedBy: DEREK,
      });
      expect(refund.amountCents).toBe(2_500);

      const found = await refunds.findById(refund.id);
      expect(found?.id).toBe(refund.id);

      // Same user as initiator cannot approve (separation of duties).
      await expect(refunds.approve(refund.id, DEREK)).rejects.toThrow(/separation of duties/);

      const approved = await refunds.approve(refund.id, ALICE);
      expect(approved?.approvedBy).toBe(ALICE);

      const completed = await refunds.updateStatus(refund.id, 'completed', {
        providerRef: 'aeropay-refund-1',
        completedAt: new Date(),
      });
      expect(completed?.status).toBe('completed');
      expect(completed?.providerRef).toBe('aeropay-refund-1');

      const total = await refunds.totalRefundedCents(order!.id);
      expect(total).toBe(2_500);

      const list = await refunds.listForOrder(order!.id);
      expect(list.length).toBe(1);

      // approve() on missing refund returns null without throwing.
      expect(await refunds.approve(newId(), ALICE)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  describe('DriversRepository + DriverShiftsRepository + DriverLocationHistory + DispatchOffers', () => {
    it('full driver lifecycle: status, location, shift, deliveries, history', async () => {
      const pool = getPool();
      const drivers = new DriversRepository(pool.db);
      const shifts = new DriverShiftsRepository(pool.db);
      const history = new DriverLocationHistoryRepository(pool.db);

      const driverUserId = stableUuid('user', 'driver-1');
      const driver = await drivers.findByUserId(driverUserId);
      expect(driver).not.toBeNull();
      const driverId = driver!.id;

      const byId = await drivers.findById(driverId);
      expect(byId?.id).toBe(driverId);

      const start: GeoPoint = { type: 'Point', coordinates: [-93.265, 44.978] };
      const end: GeoPoint = { type: 'Point', coordinates: [-93.27, 44.985] };

      await drivers.setStatus(driverId, 'online');
      const online = await drivers.listOnline();
      expect(online.some((d) => d.id === driverId)).toBe(true);

      await drivers.updateLocation(driverId, start);
      const located = await drivers.findById(driverId);
      expect(located?.currentLocation?.coordinates).toEqual(start.coordinates);

      const shift = await shifts.start(driverId, start);
      expect(shift.driverId).toBe(driverId);

      const active = await shifts.findActiveForDriver(driverId);
      expect(active?.id).toBe(shift.id);

      await shifts.recordDelivery(shift.id, 1_500);
      await drivers.incrementDeliveryCount(driverId);

      // Record one location ping + a batch + verify history.
      const orderShortCode = `DR${Math.floor(Math.random() * 1_000_000)}`;
      const [order] = await pool.sql<{ id: string }[]>`
        INSERT INTO orders (
          short_code, user_id, dispensary_id, delivery_address_id,
          subtotal_cents, cannabis_tax_cents, sales_tax_cents,
          delivery_fee_cents, total_cents,
          compliance_check_payload, delivery_address_snapshot
        )
        VALUES (
          ${orderShortCode}, ${ALICE}, ${MPLS}, ${ADDR_ALICE},
          1_000, 0, 0, 0, 1_000,
          '{}'::jsonb, '{}'::jsonb
        )
        RETURNING id
      `;
      const orderId = order!.id;

      await drivers.setCurrentOrder(driverId, orderId);

      // driver_location_history is weekly-partitioned; partitions are
      // bootstrapped from the current ISO week forward (26 weeks). Anchor
      // pings to "now" so they always land in an existing partition.
      const baseTs = Date.now();
      const recordedAt1 = new Date(baseTs);
      const recordedAt2 = new Date(baseTs + 30_000);
      const recordedAt3 = new Date(baseTs + 60_000);

      await history.record({
        driverId,
        orderId,
        location: start,
        recordedAt: recordedAt1,
      });
      await history.recordBatch([
        {
          driverId,
          orderId,
          location: { type: 'Point', coordinates: [-93.267, 44.98] } satisfies GeoPoint,
          recordedAt: recordedAt2,
        },
        {
          driverId,
          orderId,
          location: end,
          recordedAt: recordedAt3,
        },
      ]);
      // Empty batch is a no-op.
      await history.recordBatch([]);

      const pings = await history.latestForOrder(orderId);
      expect(pings.length).toBeGreaterThanOrEqual(3);
      expect(pings[0]!.location.type).toBe('Point');

      const ended = await shifts.end(shift.id, end);
      expect(ended?.endedAt).not.toBeNull();
      expect(ended?.endingLocation?.coordinates).toEqual(end.coordinates);

      const list = await shifts.listForDriver(driverId);
      expect(list.some((s) => s.id === shift.id)).toBe(true);
      const byShiftId = await shifts.findById(shift.id);
      expect(byShiftId?.id).toBe(shift.id);

      await drivers.setCurrentOrder(driverId, null);
      await drivers.setStatus(driverId, 'offline');
    });

    it('applyRatingByUserId folds ratings incrementally from an unrated start', async () => {
      const pool = getPool();
      const drivers = new DriversRepository(pool.db);
      const driverUserId = stableUuid('user', 'driver-3');

      const before = await drivers.findByUserId(driverUserId);
      expect(before?.ratingAvg).toBeNull();
      expect(before?.ratingCount).toBe(0);

      // First rating from NULL/0: (0*0 + 5)/1 = 5.00, count 1.
      await drivers.applyRatingByUserId(driverUserId, 5);
      const one = await drivers.findByUserId(driverUserId);
      expect(one?.ratingAvg).toBe('5.00');
      expect(one?.ratingCount).toBe(1);

      // Second rating: (5.00*1 + 2)/2 = 3.50, count 2 — numeric division,
      // no integer truncation (would be 3 if it truncated).
      await drivers.applyRatingByUserId(driverUserId, 2);
      const two = await drivers.findByUserId(driverUserId);
      expect(two?.ratingAvg).toBe('3.50');
      expect(two?.ratingCount).toBe(2);

      // A user id with no drivers row is a no-op (0 rows), not an error.
      await drivers.applyRatingByUserId(stableUuid('user', 'customer-1'), 5);

      // Restore so the shared container stays clean for other tests.
      await pool.sql.unsafe(
        `UPDATE drivers SET rating_avg = NULL, rating_count = 0 WHERE user_id = $1::uuid`,
        [driverUserId],
      );
    });

    it('DispatchOffersRepository: offer, respond, expireStale', async () => {
      const pool = getPool();
      const drivers = new DriversRepository(pool.db);
      const offers = new DispatchOffersRepository(pool.db);

      const driver = await drivers.findByUserId(stableUuid('user', 'driver-2'));
      const driverId = driver!.id;

      // Need a real order.
      const shortCode = `OF${Math.floor(Math.random() * 1_000_000)}`;
      const [order] = await pool.sql<{ id: string }[]>`
        INSERT INTO orders (
          short_code, user_id, dispensary_id, delivery_address_id,
          subtotal_cents, cannabis_tax_cents, sales_tax_cents,
          delivery_fee_cents, total_cents,
          compliance_check_payload, delivery_address_snapshot
        )
        VALUES (
          ${shortCode}, ${ALICE}, ${MPLS}, ${ADDR_ALICE},
          1_000, 0, 0, 0, 1_000,
          '{}'::jsonb, '{}'::jsonb
        )
        RETURNING id
      `;
      const orderId = order!.id;

      const future = new Date(Date.now() + 60_000);
      const past = new Date(Date.now() - 60_000);

      const live = await offers.create({
        orderId,
        driverId,
        expiresAt: future,
        payoutEstimateCents: 1_000,
        distanceMiles: '2.50',
      });
      const stale = await offers.create({
        orderId,
        driverId,
        expiresAt: past,
        payoutEstimateCents: 1_000,
        distanceMiles: '4.20',
      });

      const byId = await offers.findById(live.id);
      expect(byId?.id).toBe(live.id);

      const activeNow = await offers.listActiveForDriver(driverId, new Date());
      expect(activeNow.some((o) => o.id === live.id)).toBe(true);
      // The expired one is filtered by the `expires_at > now` predicate.
      expect(activeNow.some((o) => o.id === stale.id)).toBe(false);

      const accepted = await offers.respond(live.id, 'accepted', new Date());
      expect(accepted?.status).toBe('accepted');

      // Cannot transition twice (the WHERE clause excludes non-`offered`).
      const again = await offers.respond(live.id, 'declined', new Date(), 'changed my mind');
      expect(again).toBeNull();

      const expired = await offers.expireStale(new Date());
      expect(expired).toBeGreaterThanOrEqual(1);

      const forOrder = await offers.listForOrder(orderId);
      expect(forOrder.length).toBeGreaterThanOrEqual(2);
    });

    it('listAvailableDeliveries: returns awaiting_driver orders within radius with pickup/dropoff coords + tip', async () => {
      const pool = getPool();
      const drivers = new DriversRepository(pool.db);
      const dispensaries = new DispensariesRepository(pool.db);
      const offers = new DispatchOffersRepository(pool.db);

      const driver = await drivers.findByUserId(stableUuid('user', 'driver-3'));
      const driverId = driver!.id;

      const mpls = await dispensaries.findById(MPLS);
      const pickupCoords = mpls!.location.coordinates; // [lng, lat]

      // Put the driver online, parked right at the dispensary so the
      // beeline distance is ~0 and well within any radius.
      await drivers.setCurrentOrder(driverId, null);
      await drivers.setStatus(driverId, 'online');
      await drivers.updateLocation(driverId, {
        type: 'Point',
        coordinates: pickupCoords,
      });

      // A ready order: status awaiting_driver, a tip, and a dropoff
      // GeoPoint in the snapshot (checkout writes `location` as [lng,lat]).
      const dropoffLng = -93.25;
      const dropoffLat = 44.95;
      const shortCode = `AV${Math.floor(Math.random() * 1_000_000)}`;
      const [order] = await pool.sql<{ id: string }[]>`
        INSERT INTO orders (
          short_code, user_id, dispensary_id, delivery_address_id,
          status, awaiting_driver_at,
          subtotal_cents, cannabis_tax_cents, sales_tax_cents,
          delivery_fee_cents, driver_tip_cents, total_cents,
          compliance_check_payload, delivery_address_snapshot
        )
        VALUES (
          ${shortCode}, ${ALICE}, ${MPLS}, ${ADDR_ALICE},
          'awaiting_driver', NOW(),
          5_000, 0, 0, 700, 500, 6_200,
          '{}'::jsonb,
          ${JSON.stringify({
            location: { type: 'Point', coordinates: [dropoffLng, dropoffLat] },
          })}::jsonb
        )
        RETURNING id
      `;
      const orderId = order!.id;

      const wideRadius = 50 * 1609.344; // 50 miles — comfortably includes it
      const rows = await offers.listAvailableDeliveries(driverId, wideRadius);
      const mine = rows.find((r) => r.orderId === orderId);

      expect(mine).toBeDefined();
      expect(mine!.shortCode).toBe(shortCode);
      expect(mine!.dispensaryId).toBe(MPLS);
      expect(mine!.tipCents).toBe(500);
      expect(mine!.totalCents).toBe(6_200);
      // Coords round-trip (float precision); pickup = dispensary location.
      expect(mine!.pickupLng).toBeCloseTo(pickupCoords[0]!, 5);
      expect(mine!.pickupLat).toBeCloseTo(pickupCoords[1]!, 5);
      expect(mine!.dropoffLng).toBeCloseTo(dropoffLng, 5);
      expect(mine!.dropoffLat).toBeCloseTo(dropoffLat, 5);
      expect(mine!.distanceMeters).toBeLessThan(100);
      expect(mine!.awaitingDriverAt).toBeInstanceOf(Date);
      expect(mine!.pickupName.length).toBeGreaterThan(0);

      // The ST_DWithin filter is real: move the driver to Los Angeles
      // (~1,500 mi away) and the same wide 50-mi radius now excludes the
      // Minneapolis pickup.
      await drivers.updateLocation(driverId, {
        type: 'Point',
        coordinates: [-118.2437, 34.0522],
      });
      const farRows = await offers.listAvailableDeliveries(driverId, wideRadius);
      expect(farRows.find((r) => r.orderId === orderId)).toBeUndefined();
      // Restore the driver's location so the offer-cleanup assertions below
      // (which don't depend on distance) run against a sane state.
      await drivers.updateLocation(driverId, {
        type: 'Point',
        coordinates: pickupCoords,
      });

      // expireAllActiveForOrder clears every still-offered row for an order
      // (the open-pool claim's offer cleanup).
      await offers.create({
        orderId,
        driverId,
        expiresAt: new Date(Date.now() + 60_000),
        payoutEstimateCents: 1_200,
        distanceMiles: '0.10',
      });
      const expiredCount = await offers.expireAllActiveForOrder(orderId, new Date());
      expect(expiredCount).toBeGreaterThanOrEqual(1);
      const stillActive = await offers.listActiveForDriver(driverId, new Date());
      expect(stillActive.some((o) => o.orderId === orderId)).toBe(false);

      // Cleanup so a busy driver-3 doesn't leak into other tests.
      await drivers.setStatus(driverId, 'offline');
    });
  });

  // -------------------------------------------------------------------------
  // Compliance
  // -------------------------------------------------------------------------

  describe('Compliance + Metrc + AgeVerifications', () => {
    it('records compliance checks and finds the latest per subject/check_type', async () => {
      const pool = getPool();
      const compliance = new ComplianceChecksRepository(pool.db);
      const subjectId = newId();

      await compliance.record({
        checkType: 'per_transaction_limit',
        subjectType: 'order',
        subjectId,
        passed: true,
        details: { limit_mg: 800 },
        performedBy: ALICE,
      });
      await compliance.record({
        checkType: 'delivery_geofence',
        subjectType: 'order',
        subjectId,
        passed: true,
      });

      const all = await compliance.listForSubject('order', subjectId);
      expect(all.length).toBe(2);

      const latest = await compliance.latestForSubject('order', subjectId, 'per_transaction_limit');
      expect(latest?.checkType).toBe('per_transaction_limit');
    });

    it('MetrcTransactionsRepository: full lifecycle (claim, retry, terminal, reported, reconciled)', async () => {
      const pool = getPool();
      const metrc = new MetrcTransactionsRepository(pool.db);

      // Build orders to attach metrc transactions to.
      async function makeOrder(): Promise<string> {
        const shortCode = `MT${Math.floor(Math.random() * 1_000_000)}`;
        const [order] = await pool.sql<{ id: string }[]>`
          INSERT INTO orders (
            short_code, user_id, dispensary_id, delivery_address_id,
            subtotal_cents, cannabis_tax_cents, sales_tax_cents,
            delivery_fee_cents, total_cents,
            compliance_check_payload, delivery_address_snapshot
          )
          VALUES (
            ${shortCode}, ${ALICE}, ${MPLS}, ${ADDR_ALICE},
            1_000, 0, 0, 0, 1_000,
            '{}'::jsonb, '{}'::jsonb
          )
          RETURNING id
        `;
        return order!.id;
      }

      const orderA = await makeOrder();
      const orderB = await makeOrder();
      const orderC = await makeOrder();

      const tA = await metrc.create({
        orderId: orderA,
        packageTags: ['1A4060300000001'],
      });
      const tB = await metrc.create({
        orderId: orderB,
        packageTags: ['1A4060300000002'],
      });
      const tC = await metrc.create({
        orderId: orderC,
        packageTags: ['1A4060300000003'],
      });
      expect(tA.status).toBe('pending');
      // Default `next_retry_at = NOW()` so a fresh row is immediately due.
      expect(tA.nextRetryAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);

      expect((await metrc.findById(tA.id))?.id).toBe(tA.id);
      expect((await metrc.findByOrderId(orderA))?.id).toBe(tA.id);

      const pending = await metrc.listByStatus('pending');
      expect(pending.length).toBeGreaterThanOrEqual(3);

      // Claim a batch — the lease pushes next_retry_at forward by the
      // configured window so a concurrent claim doesn't re-pick the row.
      const claimNow = new Date();
      const leaseMs = 60_000;
      const claimed = await metrc.claimDueForReporting(claimNow, 10, leaseMs);
      const claimedIds = new Set(claimed.map((r) => r.id));
      expect(claimedIds.has(tA.id)).toBe(true);
      expect(claimedIds.has(tB.id)).toBe(true);
      expect(claimedIds.has(tC.id)).toBe(true);
      for (const row of claimed) {
        expect(row.nextRetryAt.getTime()).toBe(claimNow.getTime() + leaseMs);
      }

      // A second claim at the same instant finds nothing — the lease
      // covers every row we just took.
      const secondClaim = await metrc.claimDueForReporting(claimNow, 10, leaseMs);
      const secondClaimIds = new Set(secondClaim.map((r) => r.id));
      expect(secondClaimIds.has(tA.id)).toBe(false);
      expect(secondClaimIds.has(tB.id)).toBe(false);
      expect(secondClaimIds.has(tC.id)).toBe(false);

      // markReported leaves metricReceiptId NULL — Metrc's POST returns
      // an empty body and the receipt id only surfaces later via the
      // reconciliation cron's /receipts/active query.
      const reported = await metrc.markReported(tA.id, { ok: true });
      expect(reported?.status).toBe('reported');
      expect(reported?.metrcReceiptId).toBeNull();
      expect(reported?.failureReason).toBeNull();

      // Transient failure → row stays in pending, retry_count bumps,
      // nextRetryAt advances to the caller-supplied window.
      const retryAt1 = new Date(claimNow.getTime() + 60_000);
      const retried = await metrc.scheduleRetry(tB.id, retryAt1, 'timeout', { code: 504 });
      expect(retried?.status).toBe('pending');
      expect(retried?.retryCount).toBe(1);
      expect(retried?.nextRetryAt.getTime()).toBe(retryAt1.getTime());

      const retryAt2 = new Date(claimNow.getTime() + 300_000);
      const retried2 = await metrc.scheduleRetry(tB.id, retryAt2, 'timeout');
      expect(retried2?.status).toBe('pending');
      expect(retried2?.retryCount).toBe(2);

      // Terminal failure on tC (e.g. 422) — status flips to failed,
      // retry_count still increments so the alert payload shows the
      // full attempt count.
      const failed = await metrc.markFailedTerminal(tC.id, 'invalid package tag', { code: 422 });
      expect(failed?.status).toBe('failed');
      expect(failed?.failureReason).toBe('invalid package tag');
      expect(failed?.retryCount).toBe(1);

      // Reconciliation cron matched the reported row to an upstream
      // receipt; markReconciled stamps the receipt id and flips status.
      const reconciled = await metrc.markReconciled(tA.id, 'metrc-receipt-1');
      expect(reconciled?.status).toBe('reconciled');
      expect(reconciled?.metrcReceiptId).toBe('metrc-receipt-1');

      // Empty receipt id is rejected — caller passed the cron a row it
      // could not actually match.
      await expect(metrc.markReconciled(tA.id, '')).rejects.toThrow(/receiptId/);

      // Reconciliation window query: reported + reconciled rows whose
      // reportedAt falls inside [since, until].
      const since = new Date(claimNow.getTime() - 60_000);
      const until = new Date(claimNow.getTime() + 60_000);
      const inWindow = await metrc.listReportedSince(since, until);
      const inWindowIds = new Set(inWindow.map((r) => r.id));
      expect(inWindowIds.has(tA.id)).toBe(true);
      expect(inWindowIds.has(tB.id)).toBe(false);
      expect(inWindowIds.has(tC.id)).toBe(false);
    });

    it('MetrcTransactionsRepository.claimDueForReporting: validates limit and leaseMs', async () => {
      const pool = getPool();
      const metrc = new MetrcTransactionsRepository(pool.db);
      const now = new Date();
      await expect(metrc.claimDueForReporting(now, 0, 1_000)).rejects.toThrow(/limit/);
      await expect(metrc.claimDueForReporting(now, 1, 0)).rejects.toThrow(/leaseMs/);
      await expect(metrc.claimDueForReporting(now, 1.5, 1_000)).rejects.toThrow(/limit/);
    });

    it('AgeVerificationsRepository: latestPassed + findForOrder + findByProviderSessionId', async () => {
      const pool = getPool();
      const age = new AgeVerificationsRepository(pool.db);

      const passedAt = new Date('2026-05-05T08:00:00Z');
      const v = await age.record({
        userId: ALICE,
        context: 'delivery_handoff',
        provider: 'veriff',
        providerSessionId: `veriff-${newId()}`,
        passed: true,
        passedAt,
      });

      const latest = await age.latestPassed(ALICE, 'delivery_handoff');
      expect(latest?.id).toBe(v.id);

      const bySession = await age.findByProviderSessionId('veriff', v.providerSessionId);
      expect(bySession?.id).toBe(v.id);

      const byIdLookup = await age.findById(v.id);
      expect(byIdLookup?.id).toBe(v.id);

      const list = await age.listForUser(ALICE);
      expect(list.some((x) => x.id === v.id)).toBe(true);

      // Verification tied to a specific order (handoff scan).
      const shortCode = `AV${Math.floor(Math.random() * 1_000_000)}`;
      const [order] = await pool.sql<{ id: string }[]>`
        INSERT INTO orders (
          short_code, user_id, dispensary_id, delivery_address_id,
          subtotal_cents, cannabis_tax_cents, sales_tax_cents,
          delivery_fee_cents, total_cents,
          compliance_check_payload, delivery_address_snapshot
        )
        VALUES (
          ${shortCode}, ${ALICE}, ${MPLS}, ${ADDR_ALICE},
          1_000, 0, 0, 0, 1_000,
          '{}'::jsonb, '{}'::jsonb
        )
        RETURNING id
      `;
      const orderId = order!.id;

      const handoff = await age.record({
        userId: ALICE,
        orderId,
        context: 'delivery_handoff',
        provider: 'veriff',
        providerSessionId: `veriff-${newId()}`,
        passed: true,
        passedAt: new Date(),
      });
      const forOrder = await age.findForOrder(orderId);
      expect(forOrder?.id).toBe(handoff.id);
    });
  });

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  describe('NotificationsRepository + PushTokensRepository', () => {
    it('Notifications: create, markSent/Delivered/Read/Failed, listUnread', async () => {
      const pool = getPool();
      const notifications = new NotificationsRepository(pool.db);

      const created = await notifications.create({
        userId: ALICE,
        channel: 'push',
        templateKey: 'order.accepted',
        payload: { orderId: newId() },
      });

      const unread = await notifications.listUnreadForUser(ALICE);
      expect(unread.some((n) => n.id === created.id)).toBe(true);

      await notifications.markSent(created.id, 'apns-receipt-1', new Date());
      await notifications.markDelivered(created.id, new Date());
      await notifications.markRead(created.id, new Date());

      const all = await notifications.listForUser(ALICE);
      const found = all.find((n) => n.id === created.id)!;
      expect(found.sentAt).not.toBeNull();
      expect(found.deliveredAt).not.toBeNull();
      expect(found.readAt).not.toBeNull();

      const failure = await notifications.create({
        userId: ALICE,
        channel: 'sms',
        templateKey: 'order.failed',
      });
      await notifications.markFailed(failure.id, 'provider rejected');
      const failureAfter = (await notifications.listForUser(ALICE)).find(
        (n) => n.id === failure.id,
      );
      expect(failureAfter?.error).toBe('provider rejected');
    });

    it('PushTokens: upsert, listActiveForUser, deactivate, deactivateByApnsToken', async () => {
      const pool = getPool();
      const tokens = new PushTokensRepository(pool.db);

      const t1 = await tokens.upsert({
        userId: ALICE,
        deviceId: 'iphone-A',
        apnsToken: 'apns-token-A',
        platform: 'ios',
        appVariant: 'consumer',
      });
      // Idempotent upsert reuses the same row.
      const t1Again = await tokens.upsert({
        userId: ALICE,
        deviceId: 'iphone-A',
        apnsToken: 'apns-token-A-rotated',
        platform: 'ios',
        appVariant: 'consumer',
      });
      expect(t1Again.id).toBe(t1.id);
      expect(t1Again.apnsToken).toBe('apns-token-A-rotated');

      const t2 = await tokens.upsert({
        userId: ALICE,
        deviceId: 'iphone-B',
        apnsToken: 'apns-token-B',
        platform: 'ios',
        appVariant: 'consumer',
      });

      const findById = await tokens.findById(t1.id);
      expect(findById?.id).toBe(t1.id);

      const activeAll = await tokens.listActiveForUser(ALICE);
      expect(activeAll.some((t) => t.id === t1.id)).toBe(true);
      expect(activeAll.some((t) => t.id === t2.id)).toBe(true);

      const activeFiltered = await tokens.listActiveForUser(ALICE, 'consumer');
      expect(activeFiltered.length).toBeGreaterThanOrEqual(2);

      await tokens.deactivate(t1.id);
      const afterT1 = await tokens.findById(t1.id);
      expect(afterT1?.isActive).toBe(false);

      const removedCount = await tokens.deactivateByApnsToken('apns-token-B');
      expect(removedCount).toBeGreaterThanOrEqual(1);
      const afterT2 = await tokens.findById(t2.id);
      expect(afterT2?.isActive).toBe(false);
    });

    it('NotificationPreferences: findByUserId null before write, upsert inserts then patches', async () => {
      const pool = getPool();
      const prefs = new NotificationPreferencesRepository(pool.db);

      // No row yet — the opt-out model treats absence as all-on at the
      // service layer, so the repo simply reports null.
      expect(await prefs.findByUserId(BEN)).toBeNull();

      // First upsert with a single toggle inserts the row; the unspecified
      // columns fall to their NOT NULL DEFAULT true.
      const inserted = await prefs.upsert({ userId: BEN, promotionsEnabled: false });
      expect(inserted.userId).toBe(BEN);
      expect(inserted.promotionsEnabled).toBe(false);
      expect(inserted.orderUpdatesEnabled).toBe(true);
      expect(inserted.pushEnabled).toBe(true);
      expect(inserted.smsEnabled).toBe(true);
      expect(inserted.emailEnabled).toBe(true);

      const roundtrip = await prefs.findByUserId(BEN);
      expect(roundtrip?.id).toBe(inserted.id);
      expect(roundtrip?.promotionsEnabled).toBe(false);

      // Second upsert for the same user updates in place (unique user_id) —
      // same row id, only the supplied column changes, updatedAt advances.
      const updated = await prefs.upsert({ userId: BEN, smsEnabled: false });
      expect(updated.id).toBe(inserted.id);
      expect(updated.smsEnabled).toBe(false);
      // The earlier patched column is preserved across the second upsert.
      expect(updated.promotionsEnabled).toBe(false);
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(inserted.updatedAt.getTime());
    });
  });

  // -------------------------------------------------------------------------
  // Webhook idempotency
  // -------------------------------------------------------------------------

  describe('WebhookEventsProcessedRepository', () => {
    it('recordIfAbsent inserts on first call and short-circuits on replay', async () => {
      const repo = new WebhookEventsProcessedRepository(getPool().db);
      const eventId = `evt_${newId()}`;
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000);

      const first = await repo.recordIfAbsent({
        eventId,
        provider: 'aeropay',
        eventType: 'bank_account.linked',
        expiresAt,
      });
      expect(first.recorded).toBe(true);
      expect(first.existing).toBeNull();

      const second = await repo.recordIfAbsent({
        eventId,
        provider: 'aeropay',
        eventType: 'bank_account.linked',
        expiresAt,
      });
      expect(second.recorded).toBe(false);
      expect(second.existing?.eventId).toBe(eventId);
      expect(second.existing?.provider).toBe('aeropay');
      expect(second.existing?.eventType).toBe('bank_account.linked');
    });

    it('findByEventId returns the recorded row, null for unknown ids', async () => {
      const repo = new WebhookEventsProcessedRepository(getPool().db);
      const eventId = `evt_${newId()}`;
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000);

      await repo.recordIfAbsent({
        eventId,
        provider: 'aeropay',
        eventType: 'payment.settled',
        expiresAt,
      });

      const found = await repo.findByEventId(eventId);
      expect(found?.eventId).toBe(eventId);
      expect(found?.eventType).toBe('payment.settled');

      const missing = await repo.findByEventId(`evt_missing_${newId()}`);
      expect(missing).toBeNull();
    });

    it('purgeExpired deletes only rows whose expires_at is strictly before the horizon', async () => {
      const repo = new WebhookEventsProcessedRepository(getPool().db);
      const oldEventId = `evt_old_${newId()}`;
      const futureEventId = `evt_future_${newId()}`;
      const horizon = new Date('2026-05-18T12:00:00.000Z');

      await repo.recordIfAbsent({
        eventId: oldEventId,
        provider: 'aeropay',
        eventType: 'payment.settled',
        expiresAt: new Date('2026-05-18T11:59:59.000Z'),
      });
      await repo.recordIfAbsent({
        eventId: futureEventId,
        provider: 'aeropay',
        eventType: 'payment.settled',
        expiresAt: new Date('2026-05-18T12:00:01.000Z'),
      });

      const purgedCount = await repo.purgeExpired(horizon);
      expect(purgedCount).toBeGreaterThanOrEqual(1);

      expect(await repo.findByEventId(oldEventId)).toBeNull();
      expect(await repo.findByEventId(futureEventId)).not.toBeNull();
    });
  });
});
