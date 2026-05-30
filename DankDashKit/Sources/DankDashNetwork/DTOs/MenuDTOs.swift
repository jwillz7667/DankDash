import Foundation
import DankDashDomain

/// Wire shape for `MenuProductSchema` — the denormalized product summary
/// inlined on each menu line. Strictly a subset of `ProductDTO` (no lab
/// results, no createdAt/updatedAt) — the iOS menu screen renders from
/// this without an extra round-trip per row.
public struct MenuProductDTO: Decodable, Sendable, Equatable {
  public let id: String
  public let categoryId: String
  public let brand: String
  public let name: String
  public let description: String?
  public let productType: String
  public let strainType: String?
  public let thcMgPerUnit: String
  public let cbdMgPerUnit: String
  public let weightGramsPerUnit: String
  public let servingCount: Int?
  public let thcMgPerServing: String?
  public let imageKeys: [String]
  public let effectsTags: [String]
  public let flavorTags: [String]

  public init(
    id: String,
    categoryId: String,
    brand: String,
    name: String,
    description: String?,
    productType: String,
    strainType: String?,
    thcMgPerUnit: String,
    cbdMgPerUnit: String,
    weightGramsPerUnit: String,
    servingCount: Int?,
    thcMgPerServing: String?,
    imageKeys: [String],
    effectsTags: [String],
    flavorTags: [String]
  ) {
    self.id = id
    self.categoryId = categoryId
    self.brand = brand
    self.name = name
    self.description = description
    self.productType = productType
    self.strainType = strainType
    self.thcMgPerUnit = thcMgPerUnit
    self.cbdMgPerUnit = cbdMgPerUnit
    self.weightGramsPerUnit = weightGramsPerUnit
    self.servingCount = servingCount
    self.thcMgPerServing = thcMgPerServing
    self.imageKeys = imageKeys
    self.effectsTags = effectsTags
    self.flavorTags = flavorTags
  }
}

public extension MenuProductDTO {
  func toDomain() -> MenuProductSummary? {
    guard let parsedID = CatalogWire.parseUUID(id) else { return nil }
    guard let parsedCategoryID = CatalogWire.parseUUID(categoryId) else { return nil }
    guard let parsedProductType = ProductType(rawValue: productType) else { return nil }
    guard let parsedThc = CatalogWire.parseDecimal(thcMgPerUnit) else { return nil }
    guard let parsedCbd = CatalogWire.parseDecimal(cbdMgPerUnit) else { return nil }
    guard let parsedWeight = CatalogWire.parseDecimal(weightGramsPerUnit) else { return nil }
    let parsedStrain: StrainType?
    if let strainType {
      guard let parsed = StrainType(rawValue: strainType) else { return nil }
      parsedStrain = parsed
    } else {
      parsedStrain = nil
    }
    let parsedServingTHC: Decimal?
    if let thcMgPerServing {
      guard let parsed = CatalogWire.parseDecimal(thcMgPerServing) else { return nil }
      parsedServingTHC = parsed
    } else {
      parsedServingTHC = nil
    }

    return MenuProductSummary(
      id: parsedID,
      categoryId: parsedCategoryID,
      brand: brand,
      name: name,
      description: description,
      productType: parsedProductType,
      strainType: parsedStrain,
      thcMgPerUnit: parsedThc,
      cbdMgPerUnit: parsedCbd,
      weightGramsPerUnit: parsedWeight,
      servingCount: servingCount,
      thcMgPerServing: parsedServingTHC,
      imageKeys: imageKeys,
      effectsTags: effectsTags,
      flavorTags: flavorTags
    )
  }
}

/// Wire shape for `MenuItemResponseSchema`. Listing fields (listingId,
/// sku, price, quantity) are per-dispensary; the inline `product` is the
/// denormalized catalog row.
public struct MenuItemDTO: Decodable, Sendable, Equatable {
  public let listingId: String
  public let sku: String
  public let priceCents: Int
  public let compareAtPriceCents: Int?
  public let quantityAvailable: Int
  public let product: MenuProductDTO

  public init(
    listingId: String,
    sku: String,
    priceCents: Int,
    compareAtPriceCents: Int?,
    quantityAvailable: Int,
    product: MenuProductDTO
  ) {
    self.listingId = listingId
    self.sku = sku
    self.priceCents = priceCents
    self.compareAtPriceCents = compareAtPriceCents
    self.quantityAvailable = quantityAvailable
    self.product = product
  }
}

public extension MenuItemDTO {
  func toDomain() -> MenuItem? {
    guard let parsedListingID = CatalogWire.parseUUID(listingId) else { return nil }
    guard let parsedProduct = product.toDomain() else { return nil }
    return MenuItem(
      listingId: parsedListingID,
      sku: sku,
      priceCents: priceCents,
      compareAtPriceCents: compareAtPriceCents,
      quantityAvailable: quantityAvailable,
      product: parsedProduct
    )
  }
}

/// Wire envelope for `GET /v1/dispensaries/:id/menu`.
public struct MenuResponseDTO: Decodable, Sendable, Equatable {
  public let dispensaryId: String
  public let items: [MenuItemDTO]

  public init(dispensaryId: String, items: [MenuItemDTO]) {
    self.dispensaryId = dispensaryId
    self.items = items
  }

  /// Bag of `(dispensaryId, items)` projected into Domain. A malformed
  /// item is dropped rather than failing the whole menu.
  public func toDomain() -> (dispensaryId: UUID, items: [MenuItem])? {
    guard let parsedDispensaryID = CatalogWire.parseUUID(dispensaryId) else { return nil }
    return (parsedDispensaryID, items.compactMap { $0.toDomain() })
  }
}
