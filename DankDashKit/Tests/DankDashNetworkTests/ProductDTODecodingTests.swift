import XCTest
import DankDashDomain
@testable import DankDashNetwork

final class ProductDTODecodingTests: XCTestCase {
  private let decoder = JSONDecoder()

  func test_product_decodesAndProjectsToDomain() throws {
    let data = Self.productJSON.data(using: .utf8)!
    let dto = try decoder.decode(ProductDTO.self, from: data)
    let product = try XCTUnwrap(dto.toDomain())

    XCTAssertEqual(product.id, UUID(uuidString: "0190B7A6-1100-72F5-A6B0-1C6F77CE0001"))
    XCTAssertEqual(product.brand, "DankCo")
    XCTAssertEqual(product.name, "Gorilla Glue #4 3.5g")
    XCTAssertEqual(product.productType, .flower)
    XCTAssertEqual(product.strainType, .hybrid)
    XCTAssertEqual(product.thcMgPerUnit, Decimal(string: "875.00"))
    XCTAssertEqual(product.cbdMgPerUnit, Decimal(string: "12.50"))
    XCTAssertEqual(product.weightGramsPerUnit, Decimal(string: "3.50"))
    XCTAssertEqual(product.servingCount, nil)
    XCTAssertEqual(product.imageKeys, ["products/gg4/0.jpg", "products/gg4/1.jpg"])
    XCTAssertEqual(product.effectsTags, ["relaxed", "happy"])
    XCTAssertEqual(product.flavorTags, ["earthy", "pine"])
    XCTAssertEqual(product.labResults.count, 2)
    XCTAssertEqual(product.headlineLabResult?.batchId, "BATCH-001")
    XCTAssertEqual(product.headlineLabResult?.potencyThc, Decimal(string: "24.97"))
  }

  func test_product_rejectsUnknownStrainType() throws {
    let bad = Self.productJSON.replacingOccurrences(
      of: "\"strainType\": \"hybrid\"",
      with: "\"strainType\": \"alien\""
    )
    let dto = try decoder.decode(ProductDTO.self, from: bad.data(using: .utf8)!)
    XCTAssertNil(dto.toDomain())
  }

  func test_product_acceptsNullStrainTypeForBalanced() throws {
    let withNullStrain = Self.productJSON.replacingOccurrences(
      of: "\"strainType\": \"hybrid\"",
      with: "\"strainType\": null"
    )
    let dto = try decoder.decode(ProductDTO.self, from: withNullStrain.data(using: .utf8)!)
    let product = try XCTUnwrap(dto.toDomain())
    XCTAssertNil(product.strainType)
  }

  func test_product_dropsMalformedLabResultButKeepsProduct() throws {
    let bad = Self.productJSON.replacingOccurrences(
      of: "\"id\": \"0190B7A7-1100-72F5-A6B0-1C6F77CE0001\"",
      with: "\"id\": \"not-a-uuid\""
    )
    let dto = try decoder.decode(ProductDTO.self, from: bad.data(using: .utf8)!)
    let product = try XCTUnwrap(dto.toDomain())
    XCTAssertEqual(product.labResults.count, 1, "malformed lab result drops; product survives")
  }

  func test_labResult_decodesWithNullPotency() throws {
    let json = """
    {
      "id": "0190B7A7-1100-72F5-A6B0-1C6F77CE0001",
      "batchId": "BATCH-002",
      "labName": "Steep Hill Labs",
      "coaDocumentKey": null,
      "potencyThc": null,
      "potencyCbd": null,
      "contaminantsPassed": null,
      "testedAt": "2026-02-01"
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(LabResultDTO.self, from: json)
    let domain = try XCTUnwrap(dto.toDomain())
    XCTAssertNil(domain.potencyThc)
    XCTAssertNil(domain.potencyCbd)
    XCTAssertNil(domain.contaminantsPassed)
  }

  func test_decimalArithmeticRoundTripsAcrossDTOBoundary() throws {
    let dto = try decoder.decode(ProductDTO.self, from: Self.productJSON.data(using: .utf8)!)
    let product = try XCTUnwrap(dto.toDomain())
    let sum = product.thcMgPerUnit + product.cbdMgPerUnit
    XCTAssertEqual(sum, Decimal(string: "887.50"))
  }

  // MARK: - Fixtures

  private static let productJSON = """
  {
    "id": "0190B7A6-1100-72F5-A6B0-1C6F77CE0001",
    "categoryId": "0190B7A6-CAFE-72F5-A6B0-1C6F77CE0001",
    "brand": "DankCo",
    "name": "Gorilla Glue #4 3.5g",
    "description": "A balanced hybrid with gluey, dense buds.",
    "productType": "flower",
    "strainType": "hybrid",
    "thcMgPerUnit": "875.00",
    "cbdMgPerUnit": "12.50",
    "weightGramsPerUnit": "3.50",
    "servingCount": null,
    "thcMgPerServing": null,
    "imageKeys": ["products/gg4/0.jpg", "products/gg4/1.jpg"],
    "effectsTags": ["relaxed", "happy"],
    "flavorTags": ["earthy", "pine"],
    "createdAt": "2026-01-10T12:00:00.000Z",
    "updatedAt": "2026-05-15T08:30:00.000Z",
    "labResults": [
      {
        "id": "0190B7A7-1100-72F5-A6B0-1C6F77CE0001",
        "batchId": "BATCH-001",
        "labName": "Anresco",
        "coaDocumentKey": "coas/batch-001.pdf",
        "potencyThc": "24.97",
        "potencyCbd": "0.36",
        "contaminantsPassed": true,
        "testedAt": "2026-04-01"
      },
      {
        "id": "0190B7A7-2200-72F5-A6B0-1C6F77CE0002",
        "batchId": "BATCH-002",
        "labName": "Steep Hill Labs",
        "coaDocumentKey": "coas/batch-002.pdf",
        "potencyThc": "23.50",
        "potencyCbd": "0.30",
        "contaminantsPassed": true,
        "testedAt": "2026-03-15"
      }
    ]
  }
  """
}
