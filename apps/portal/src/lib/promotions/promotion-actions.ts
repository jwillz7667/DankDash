/**
 * Contract the promotions page uses to talk to the vendor promotions
 * surface. Factored as an interface so production wires the Next server
 * actions while tests inject in-memory fakes (mirrors VendorProductActions /
 * VendorPayoutActions).
 */
import type {
  CreateVendorPromotionInput,
  PatchVendorPromotionInput,
  VendorPromotion,
} from '../api/vendor-promotions.js';

export interface VendorPromotionActions {
  readonly list: () => Promise<readonly VendorPromotion[]>;
  readonly create: (input: CreateVendorPromotionInput) => Promise<VendorPromotion>;
  readonly patch: (id: string, input: PatchVendorPromotionInput) => Promise<VendorPromotion>;
  readonly deactivate: (id: string) => Promise<void>;
}
