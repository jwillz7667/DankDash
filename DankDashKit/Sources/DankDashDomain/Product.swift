import Foundation

/// Full product detail with attached lab results — the response shape of
/// `GET /v1/products/:id`. Decimal cannabis fields are wire-encoded as
/// strings; the DTO layer parses them via `Decimal(string:)` to preserve
/// precision. Never use `Double` for THC/CBD/weight — rounding errors
/// accumulate across cart math and fail compliance audits.
public struct Product: Identifiable, Hashable, Sendable, Codable {
  public let id: UUID
  public let categoryId: UUID
  public let brand: String
  public let name: String
  public let description: String?
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
  public let createdAt: Date
  public let updatedAt: Date
  public let labResults: [LabResult]

  public init(
    id: UUID,
    categoryId: UUID,
    brand: String,
    name: String,
    description: String?,
    productType: ProductType,
    strainType: StrainType?,
    thcMgPerUnit: Decimal,
    cbdMgPerUnit: Decimal,
    weightGramsPerUnit: Decimal,
    servingCount: Int?,
    thcMgPerServing: Decimal?,
    imageKeys: [String],
    effectsTags: [String],
    flavorTags: [String],
    createdAt: Date,
    updatedAt: Date,
    labResults: [LabResult]
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
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.labResults = labResults
  }

  public var headlineLabResult: LabResult? { labResults.first }
}

/// The inline product summary surfaced on a menu line. Strictly a subset
/// of `Product` — no lab results, no created/updated timestamps. The iOS
/// detail screen renders from this summary while the full `Product`
/// loads in the background.
public struct MenuProductSummary: Identifiable, Hashable, Sendable, Codable {
  public let id: UUID
  public let categoryId: UUID
  public let brand: String
  public let name: String
  public let description: String?
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
    description: String?,
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
