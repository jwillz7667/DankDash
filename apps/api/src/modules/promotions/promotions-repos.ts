import type { Database, PromoCodesRepository, PromoRedemptionsRepository } from '@dankdash/db';

/** Tx-bound repositories the promotions services operate through. */
export interface PromotionsScopedRepos {
  readonly promoCodes: PromoCodesRepository;
  readonly promoRedemptions: PromoRedemptionsRepository;
}

export type PromotionsScopedReposFactory = (db: Database) => PromotionsScopedRepos;
