import Foundation
import DankDashDomain

/// Wire shape for `SearchProductResultSchema` — a search hit. Narrower
/// than `ProductDTO` (no description, no labResults, no created/updated
/// timestamps) by design — the browse UI renders list items only.
public struct SearchProductResultDTO: Decodable, Sendable, Equatable {
  public let id: String
  public let categoryId: String
  public let brand: String
  public let name: String
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

public extension SearchProductResultDTO {
  func toDomain() -> SearchProductResult? {
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
    return SearchProductResult(
      id: parsedID,
      categoryId: parsedCategoryID,
      brand: brand,
      name: name,
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

public struct SearchCategoryFacetDTO: Decodable, Sendable, Equatable {
  public let categoryId: String
  public let count: Int

  public init(categoryId: String, count: Int) {
    self.categoryId = categoryId
    self.count = count
  }

  public func toDomain() -> SearchCategoryFacet? {
    guard let parsedID = CatalogWire.parseUUID(categoryId) else { return nil }
    return SearchCategoryFacet(categoryId: parsedID, count: count)
  }
}

public struct SearchStrainTypeFacetDTO: Decodable, Sendable, Equatable {
  public let strainType: String
  public let count: Int

  public init(strainType: String, count: Int) {
    self.strainType = strainType
    self.count = count
  }

  public func toDomain() -> SearchStrainTypeFacet? {
    guard let parsed = StrainType(rawValue: strainType) else { return nil }
    return SearchStrainTypeFacet(strainType: parsed, count: count)
  }
}

public struct SearchPageDTO: Decodable, Sendable, Equatable {
  public let limit: Int
  public let offset: Int
  public let total: Int

  public init(limit: Int, offset: Int, total: Int) {
    self.limit = limit
    self.offset = offset
    self.total = total
  }

  public func toDomain() -> SearchPage {
    SearchPage(limit: limit, offset: offset, total: total)
  }
}

public struct SearchFacetsDTO: Decodable, Sendable, Equatable {
  public let categories: [SearchCategoryFacetDTO]
  public let strainTypes: [SearchStrainTypeFacetDTO]

  public init(categories: [SearchCategoryFacetDTO], strainTypes: [SearchStrainTypeFacetDTO]) {
    self.categories = categories
    self.strainTypes = strainTypes
  }
}

public struct SearchProductsResponseDTO: Decodable, Sendable, Equatable {
  public let results: [SearchProductResultDTO]
  public let facets: SearchFacetsDTO
  public let page: SearchPageDTO

  public init(
    results: [SearchProductResultDTO],
    facets: SearchFacetsDTO,
    page: SearchPageDTO
  ) {
    self.results = results
    self.facets = facets
    self.page = page
  }

  public func toDomain() -> SearchResults {
    SearchResults(
      results: results.compactMap { $0.toDomain() },
      categoryFacets: facets.categories.compactMap { $0.toDomain() },
      strainTypeFacets: facets.strainTypes.compactMap { $0.toDomain() },
      page: page.toDomain()
    )
  }
}

/// Query parameter bag for `GET /v1/products/search`. All fields are
/// optional except limit/offset, which the server defaults to 24/0.
public struct SearchProductsQuery: Sendable, Equatable {
  public var q: String?
  public var categoryId: UUID?
  public var strainType: StrainType?
  public var dispensaryId: UUID?
  public var limit: Int
  public var offset: Int

  public init(
    q: String? = nil,
    categoryId: UUID? = nil,
    strainType: StrainType? = nil,
    dispensaryId: UUID? = nil,
    limit: Int = 24,
    offset: Int = 0
  ) {
    self.q = q
    self.categoryId = categoryId
    self.strainType = strainType
    self.dispensaryId = dispensaryId
    self.limit = limit
    self.offset = offset
  }

  /// Renders the query as `URLQueryItem`s the network layer can attach
  /// to the search endpoint URL. Empty / nil fields are skipped so the
  /// server's default kicks in.
  public var queryItems: [URLQueryItem] {
    var items: [URLQueryItem] = []
    if let q, !q.isEmpty {
      items.append(URLQueryItem(name: "q", value: q))
    }
    if let categoryId {
      items.append(URLQueryItem(name: "category", value: categoryId.uuidString.lowercased()))
    }
    if let strainType {
      items.append(URLQueryItem(name: "strain_type", value: strainType.rawValue))
    }
    if let dispensaryId {
      items.append(URLQueryItem(name: "dispensary_id", value: dispensaryId.uuidString.lowercased()))
    }
    items.append(URLQueryItem(name: "limit", value: String(limit)))
    items.append(URLQueryItem(name: "offset", value: String(offset)))
    return items
  }
}
