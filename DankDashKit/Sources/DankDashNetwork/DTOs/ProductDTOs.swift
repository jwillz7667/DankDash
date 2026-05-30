import Foundation
import DankDashDomain

/// Wire shape for `LabResultResponseSchema`. `testedAt` is a YYYY-MM-DD
/// string so the iOS UI can render it verbatim without timezone math.
public struct LabResultDTO: Decodable, Sendable, Equatable {
  public let id: String
  public let batchId: String
  public let labName: String
  public let coaDocumentKey: String?
  public let potencyThc: String?
  public let potencyCbd: String?
  public let contaminantsPassed: Bool?
  public let testedAt: String

  public init(
    id: String,
    batchId: String,
    labName: String,
    coaDocumentKey: String?,
    potencyThc: String?,
    potencyCbd: String?,
    contaminantsPassed: Bool?,
    testedAt: String
  ) {
    self.id = id
    self.batchId = batchId
    self.labName = labName
    self.coaDocumentKey = coaDocumentKey
    self.potencyThc = potencyThc
    self.potencyCbd = potencyCbd
    self.contaminantsPassed = contaminantsPassed
    self.testedAt = testedAt
  }
}

public extension LabResultDTO {
  func toDomain() -> LabResult? {
    guard let parsedID = CatalogWire.parseUUID(id) else { return nil }
    let parsedThc = potencyThc.flatMap(CatalogWire.parseDecimal)
    let parsedCbd = potencyCbd.flatMap(CatalogWire.parseDecimal)
    if potencyThc != nil, parsedThc == nil { return nil }
    if potencyCbd != nil, parsedCbd == nil { return nil }
    return LabResult(
      id: parsedID,
      batchId: batchId,
      labName: labName,
      coaDocumentKey: coaDocumentKey,
      potencyThc: parsedThc,
      potencyCbd: parsedCbd,
      contaminantsPassed: contaminantsPassed,
      testedAt: testedAt
    )
  }
}

/// Wire shape for `ProductResponseSchema`. All numeric cannabis values
/// flow as decimal strings; the Domain mapping parses them once into
/// `Decimal` so compliance math elsewhere never has to second-guess.
public struct ProductDTO: Decodable, Sendable, Equatable {
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
  public let createdAt: String
  public let updatedAt: String
  public let labResults: [LabResultDTO]

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
    flavorTags: [String],
    createdAt: String,
    updatedAt: String,
    labResults: [LabResultDTO]
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
}

public extension ProductDTO {
  func toDomain() -> Product? {
    guard let parsedID = CatalogWire.parseUUID(id) else { return nil }
    guard let parsedCategoryID = CatalogWire.parseUUID(categoryId) else { return nil }
    guard let parsedProductType = ProductType(rawValue: productType) else { return nil }
    guard let parsedThc = CatalogWire.parseDecimal(thcMgPerUnit) else { return nil }
    guard let parsedCbd = CatalogWire.parseDecimal(cbdMgPerUnit) else { return nil }
    guard let parsedWeight = CatalogWire.parseDecimal(weightGramsPerUnit) else { return nil }
    guard let parsedCreatedAt = CatalogWire.parseISO8601(createdAt) else { return nil }
    guard let parsedUpdatedAt = CatalogWire.parseISO8601(updatedAt) else { return nil }
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

    return Product(
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
      flavorTags: flavorTags,
      createdAt: parsedCreatedAt,
      updatedAt: parsedUpdatedAt,
      labResults: labResults.compactMap { $0.toDomain() }
    )
  }
}
