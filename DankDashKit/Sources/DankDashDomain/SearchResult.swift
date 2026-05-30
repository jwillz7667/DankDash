import Foundation

/// A single product hit from `GET /v1/products/search`. Narrower than
/// `Product` by design — no `description`, no `labResults`, no
/// `createdAt`/`updatedAt`. The browse UI renders list items only; the
/// detail screen re-fetches the full record.
public struct SearchProductResult: Identifiable, Hashable, Sendable, Codable {
  public let id: UUID
  public let categoryId: UUID
  public let brand: String
  public let name: String
  public let productType: ProductType
  public let strainType: StrainType?
  public let thcMgPerUnit: Decimal
  public let cbdMgPerUnit: Decimal
  public let weightGramsPerUnit: Decimal
  public let servingCount: Int?
  public let thcMgPerServing: Decimal?
  public let imageKeys: [String]
  public let effectsTags: [String]
  public let flavorTags: [String]

  public init(
    id: UUID,
    categoryId: UUID,
    brand: String,
    name: String,
    productType: ProductType,
    strainType: StrainType?,
    thcMgPerUnit: Decimal,
    cbdMgPerUnit: Decimal,
    weightGramsPerUnit: Decimal,
    servingCount: Int?,
    thcMgPerServing: Decimal?,
    imageKeys: [String],
    effectsTags: [String],
    flavorTags: [String]
  ) {
    self.id = id
    self.categoryId = categoryId
    self.brand = brand
    self.name = name
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

public struct SearchCategoryFacet: Hashable, Sendable, Codable {
  public let categoryId: UUID
  public let count: Int

  public init(categoryId: UUID, count: Int) {
    self.categoryId = categoryId
    self.count = count
  }
}

public struct SearchStrainTypeFacet: Hashable, Sendable, Codable {
  public let strainType: StrainType
  public let count: Int

  public init(strainType: StrainType, count: Int) {
    self.strainType = strainType
    self.count = count
  }
}

public struct SearchPage: Hashable, Sendable, Codable {
  public let limit: Int
  public let offset: Int
  public let total: Int

  public init(limit: Int, offset: Int, total: Int) {
    self.limit = limit
    self.offset = offset
    self.total = total
  }

  public var hasNextPage: Bool {
    offset + limit < total
  }
}

/// Aggregate response shape from the search endpoint — `results` plus the
/// two facet axes and the page envelope.
public struct SearchResults: Hashable, Sendable, Codable {
  public let results: [SearchProductResult]
  public let categoryFacets: [SearchCategoryFacet]
  public let strainTypeFacets: [SearchStrainTypeFacet]
  public let page: SearchPage

  public init(
    results: [SearchProductResult],
    categoryFacets: [SearchCategoryFacet],
    strainTypeFacets: [SearchStrainTypeFacet],
    page: SearchPage
  ) {
    self.results = results
    self.categoryFacets = categoryFacets
    self.strainTypeFacets = strainTypeFacets
    self.page = page
  }
}
