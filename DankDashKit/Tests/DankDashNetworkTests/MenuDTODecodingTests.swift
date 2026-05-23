import XCTest
import DankDashDomain
@testable import DankDashNetwork

final class MenuDTODecodingTests: XCTestCase {
  private let decoder = JSONDecoder()

  func test_menuResponse_decodesAndProjectsToDomain() throws {
    let data = Self.menuJSON.data(using: .utf8)!
    let envelope = try decoder.decode(MenuResponseDTO.self, from: data)
    let projected = try XCTUnwrap(envelope.toDomain())

    XCTAssertEqual(projected.dispensaryId, UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0001"))
    XCTAssertEqual(projected.items.count, 2)

    let flower = try XCTUnwrap(projected.items.first)
    XCTAssertEqual(flower.sku, "GG4-3.5G")
    XCTAssertEqual(flower.priceCents, 4500)
    XCTAssertEqual(flower.compareAtPriceCents, 5000)
    XCTAssertEqual(flower.quantityAvailable, 12)
    XCTAssertTrue(flower.isInStock)
    XCTAssertTrue(flower.isOnSale)
    XCTAssertEqual(flower.product.brand, "DankCo")
    XCTAssertEqual(flower.product.name, "Gorilla Glue #4 3.5g")
    XCTAssertEqual(flower.product.productType, .flower)
    XCTAssertEqual(flower.product.strainType, .hybrid)
    XCTAssertEqual(flower.product.thcMgPerUnit, Decimal(string: "875.00"))
    XCTAssertEqual(flower.product.effectsTags, ["relaxed", "happy"])

    let oos = projected.items[1]
    XCTAssertFalse(oos.isInStock)
    XCTAssertFalse(oos.isOnSale)
    XCTAssertNil(oos.compareAtPriceCents)
  }

  func test_menuItem_rejectsUnknownProductType() throws {
    let bad = Self.menuJSON.replacingOccurrences(
      of: "\"productType\": \"flower\"",
      with: "\"productType\": \"unicorn\""
    )
    let dto = try decoder.decode(MenuResponseDTO.self, from: bad.data(using: .utf8)!)
    let projected = try XCTUnwrap(dto.toDomain())
    XCTAssertEqual(projected.items.count, 1, "malformed item should be silently dropped")
  }

  func test_menuItem_rejectsMalformedDecimalString() throws {
    let bad = Self.menuJSON.replacingOccurrences(
      of: "\"thcMgPerUnit\": \"875.00\"",
      with: "\"thcMgPerUnit\": \"eight hundred\""
    )
    let dto = try decoder.decode(MenuResponseDTO.self, from: bad.data(using: .utf8)!)
    let projected = try XCTUnwrap(dto.toDomain())
    XCTAssertEqual(projected.items.count, 1, "malformed decimal drops the row")
  }

  func test_menuResponse_rejectsMalformedDispensaryUUID() throws {
    let bad = Self.menuJSON.replacingOccurrences(
      of: "\"dispensaryId\": \"0190B7A4-9C00-72F5-A6B0-1C6F77CE0001\"",
      with: "\"dispensaryId\": \"not-a-uuid\""
    )
    let dto = try decoder.decode(MenuResponseDTO.self, from: bad.data(using: .utf8)!)
    XCTAssertNil(dto.toDomain())
  }

  // MARK: - Fixtures

  private static let menuJSON = """
  {
    "dispensaryId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0001",
    "items": [
      {
        "listingId": "0190B7A5-1100-72F5-A6B0-1C6F77CE0001",
        "sku": "GG4-3.5G",
        "priceCents": 4500,
        "compareAtPriceCents": 5000,
        "quantityAvailable": 12,
        "product": {
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
          "imageKeys": ["products/gg4/0.jpg"],
          "effectsTags": ["relaxed", "happy"],
          "flavorTags": ["earthy", "pine"]
        }
      },
      {
        "listingId": "0190B7A5-2200-72F5-A6B0-1C6F77CE0002",
        "sku": "VAPE-1G",
        "priceCents": 6500,
        "compareAtPriceCents": null,
        "quantityAvailable": 0,
        "product": {
          "id": "0190B7A6-2200-72F5-A6B0-1C6F77CE0002",
          "categoryId": "0190B7A6-CAFE-72F5-A6B0-1C6F77CE0002",
          "brand": "Stiiizy",
          "name": "Sour Diesel Pod 1g",
          "description": null,
          "productType": "vape",
          "strainType": "sativa",
          "thcMgPerUnit": "830.00",
          "cbdMgPerUnit": "0.00",
          "weightGramsPerUnit": "1.00",
          "servingCount": null,
          "thcMgPerServing": null,
          "imageKeys": [],
          "effectsTags": ["uplifted"],
          "flavorTags": ["diesel"]
        }
      }
    ]
  }
  """
}
