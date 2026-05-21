import Foundation

/// Catalog product category enum. Matches `apps/api/.../catalog/dto/product.dto.ts`
/// `ProductTypeSchema`. The raw value is the wire form.
public enum ProductType: String, Hashable, Sendable, CaseIterable, Codable {
  case flower
  case preroll
  case infusedPreroll = "infused_preroll"
  case vape
  case edible
  case beverage
  case concentrate
  case tincture
  case topical
  case accessory
  case seed
  case clone
}
