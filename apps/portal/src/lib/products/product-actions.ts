/**
 * Contract the products page uses to talk to the vendor product-authoring
 * surface. Factored as an interface so production wires the Next server
 * actions while tests inject in-memory fakes (mirrors VendorListingActions /
 * VendorSettingsActions).
 */
import type { ImageUploadTicket, UploadableImageType } from '../api/image-uploads.js';
import type {
  CreateVendorProductInput,
  PatchVendorProductInput,
  ProductCategory,
  VendorProduct,
} from '../api/vendor-products.js';

export interface VendorProductActions {
  readonly list: () => Promise<readonly VendorProduct[]>;
  readonly create: (input: CreateVendorProductInput) => Promise<VendorProduct>;
  readonly patch: (id: string, input: PatchVendorProductInput) => Promise<VendorProduct>;
  readonly remove: (id: string) => Promise<void>;
  readonly requestImageUpload: (contentType: UploadableImageType) => Promise<ImageUploadTicket>;
}

export type { ProductCategory };
