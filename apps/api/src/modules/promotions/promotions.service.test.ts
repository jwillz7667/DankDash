/**
 * Unit tests for the vendor and admin promotions services. In-memory fakes
 * stand in for the DB; the RLS `set_config` call in the vendor `withScope` is
 * satisfied by a fake tx that no-ops `execute`.
 */
import type {
  Database,
  NewPromoCode,
  PromoCode,
  PromoCodePatch,
  PromoCodesRepository,
  PromoRedemptionsRepository,
} from '@dankdash/db';
import { ConflictError, ForbiddenError, NotFoundError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { AdminPromotionsService } from './admin/admin-promotions.service.js';
import { VendorPromotionsService } from './vendor/vendor-promotions.service.js';
import type { CreatePromoRequest } from './dto/index.js';
import type { PromotionsScopedRepos } from './promotions-repos.js';
import type { VendorContext } from '../listings/vendor/vendor-context.types.js';

const DISPENSARY_ID = '01935f3d-0000-7000-8000-0000000000a1';
const USER_ID = '01935f3d-0000-7000-8000-000000000001';
const STAFF_ID = '01935f3d-0000-7000-8000-000000000002';

function vendorCtx(staffRole: VendorContext['staffRole'] = 'manager'): VendorContext {
  return { dispensaryId: DISPENSARY_ID, userId: USER_ID, staffRole, staffMemberId: STAFF_ID };
}

let idSeq = 0;

class FakePromoCodesRepo implements Pick<
  PromoCodesRepository,
  | 'findByCode'
  | 'create'
  | 'listForDispensary'
  | 'listPlatform'
  | 'updateForDispensary'
  | 'updatePlatform'
> {
  public rows = new Map<string, PromoCode>();

  seed(promo: PromoCode): void {
    this.rows.set(promo.id, promo);
  }

  findByCode(code: string): Promise<PromoCode | null> {
    const row = [...this.rows.values()].find((r) => r.code.toUpperCase() === code.toUpperCase());
    return Promise.resolve(row ?? null);
  }

  create(input: Omit<NewPromoCode, 'id'> & { readonly id?: string }): Promise<PromoCode> {
    const at = new Date('2026-05-01T00:00:00.000Z');
    const row: PromoCode = {
      id: input.id ?? `promo-${String(++idSeq)}`,
      code: input.code,
      type: input.type,
      value: input.value,
      scope: input.scope,
      dispensaryId: input.dispensaryId ?? null,
      minSubtotalCents: input.minSubtotalCents ?? 0,
      maxDiscountCents: input.maxDiscountCents ?? null,
      startsAt: input.startsAt,
      endsAt: input.endsAt ?? null,
      maxRedemptions: input.maxRedemptions ?? null,
      maxRedemptionsPerUser: input.maxRedemptionsPerUser ?? 1,
      active: input.active ?? true,
      createdBy: input.createdBy ?? null,
      createdAt: at,
      updatedAt: at,
    };
    this.rows.set(row.id, row);
    return Promise.resolve(row);
  }

  listForDispensary(dispensaryId: string): Promise<readonly PromoCode[]> {
    return Promise.resolve([...this.rows.values()].filter((r) => r.dispensaryId === dispensaryId));
  }

  listPlatform(): Promise<readonly PromoCode[]> {
    return Promise.resolve([...this.rows.values()].filter((r) => r.scope === 'platform'));
  }

  updateForDispensary(
    id: string,
    dispensaryId: string,
    patch: PromoCodePatch,
  ): Promise<PromoCode | null> {
    const row = this.rows.get(id);
    if (row?.dispensaryId !== dispensaryId) return Promise.resolve(null);
    const next = { ...row, ...patch, updatedAt: new Date() } as PromoCode;
    this.rows.set(id, next);
    return Promise.resolve(next);
  }

  updatePlatform(id: string, patch: PromoCodePatch): Promise<PromoCode | null> {
    const row = this.rows.get(id);
    if (row?.scope !== 'platform') return Promise.resolve(null);
    const next = { ...row, ...patch, updatedAt: new Date() } as PromoCode;
    this.rows.set(id, next);
    return Promise.resolve(next);
  }
}

class FakePromoRedemptionsRepo implements Pick<
  PromoRedemptionsRepository,
  'countsForPromos' | 'countForPromo'
> {
  public counts = new Map<string, number>();

  countsForPromos(promoIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    const out = new Map<string, number>();
    for (const id of promoIds) {
      const n = this.counts.get(id);
      if (n !== undefined) out.set(id, n);
    }
    return Promise.resolve(out);
  }

  countForPromo(promoId: string): Promise<number> {
    return Promise.resolve(this.counts.get(promoId) ?? 0);
  }
}

interface Rig {
  readonly vendor: VendorPromotionsService;
  readonly admin: AdminPromotionsService;
  readonly promoCodes: FakePromoCodesRepo;
  readonly promoRedemptions: FakePromoRedemptionsRepo;
}

function makeRig(): Rig {
  const promoCodes = new FakePromoCodesRepo();
  const promoRedemptions = new FakePromoRedemptionsRepo();
  const repos = { promoCodes, promoRedemptions } as unknown as PromotionsScopedRepos;
  const fakeDb = {
    transaction: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({ execute: () => Promise.resolve() }),
    execute: () => Promise.resolve(),
  } as unknown as Database;
  const factory = (): PromotionsScopedRepos => repos;
  return {
    vendor: new VendorPromotionsService(fakeDb, factory),
    admin: new AdminPromotionsService(fakeDb, factory),
    promoCodes,
    promoRedemptions,
  };
}

function createBody(overrides: Partial<CreatePromoRequest> = {}): CreatePromoRequest {
  return {
    code: 'SAVE10',
    type: 'percent',
    value: 10,
    minSubtotalCents: 0,
    startsAt: '2026-05-01T00:00:00.000Z',
    maxRedemptionsPerUser: 1,
    ...overrides,
  };
}

describe('VendorPromotionsService', () => {
  it('creates a dispensary-scoped promo pinned to the caller dispensary', async () => {
    const rig = makeRig();

    const res = await rig.vendor.create(vendorCtx(), createBody({ code: 'SAVE10' }));

    expect(res.scope).toBe('dispensary');
    expect(res.dispensaryId).toBe(DISPENSARY_ID);
    expect(res.code).toBe('SAVE10');
    expect(res.redemptionCount).toBe(0);
  });

  it('rejects a duplicate code with a 409', async () => {
    const rig = makeRig();
    await rig.vendor.create(vendorCtx(), createBody({ code: 'DUP' }));

    await expect(
      rig.vendor.create(vendorCtx(), createBody({ code: 'DUP' })),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('lists the dispensary promos with their redemption counts', async () => {
    const rig = makeRig();
    const created = await rig.vendor.create(vendorCtx(), createBody({ code: 'LIST1' }));
    rig.promoRedemptions.counts.set(created.id, 7);

    const res = await rig.vendor.list(vendorCtx());

    expect(res.promotions).toHaveLength(1);
    expect(res.promotions[0]?.redemptionCount).toBe(7);
  });

  it('deactivates a promo (404 on cross-dispensary id)', async () => {
    const rig = makeRig();
    const created = await rig.vendor.create(vendorCtx(), createBody({ code: 'OFF' }));

    await rig.vendor.deactivate(vendorCtx(), created.id);
    expect(rig.promoCodes.rows.get(created.id)?.active).toBe(false);

    await expect(rig.vendor.deactivate(vendorCtx(), 'nonexistent')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('reactivates via patch { active: true }', async () => {
    const rig = makeRig();
    const created = await rig.vendor.create(vendorCtx(), createBody({ code: 'BACK' }));
    await rig.vendor.deactivate(vendorCtx(), created.id);

    const res = await rig.vendor.patch(vendorCtx(), created.id, { active: true });

    expect(res.active).toBe(true);
  });

  it('forbids a budtender from managing promotions', async () => {
    const rig = makeRig();

    await expect(rig.vendor.create(vendorCtx('budtender'), createBody())).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(rig.vendor.list(vendorCtx('budtender'))).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('AdminPromotionsService', () => {
  it('creates a platform-scoped promo with a null dispensary', async () => {
    const rig = makeRig();

    const res = await rig.admin.create(USER_ID, createBody({ code: 'PLATFORM10' }));

    expect(res.scope).toBe('platform');
    expect(res.dispensaryId).toBeNull();
  });

  it('lists only platform promos', async () => {
    const rig = makeRig();
    await rig.admin.create(USER_ID, createBody({ code: 'PLAT' }));
    await rig.vendor.create(vendorCtx(), createBody({ code: 'DISP' }));

    const res = await rig.admin.list();

    expect(res.promotions).toHaveLength(1);
    expect(res.promotions[0]?.code).toBe('PLAT');
  });

  it('deactivates a platform promo and 404s a dispensary id', async () => {
    const rig = makeRig();
    const created = await rig.admin.create(USER_ID, createBody({ code: 'PDEACT' }));
    const dispPromo = await rig.vendor.create(vendorCtx(), createBody({ code: 'NOTPLAT' }));

    await rig.admin.deactivate(created.id);
    expect(rig.promoCodes.rows.get(created.id)?.active).toBe(false);

    await expect(rig.admin.deactivate(dispPromo.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});
