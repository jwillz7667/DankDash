import XCTest
import DankDashDomain
@testable import DankDashNetwork

final class CategoryDTODecodingTests: XCTestCase {
  private let decoder = JSONDecoder()

  func test_categoryList_decodesAndProjectsToDomain() throws {
    let data = Self.listJSON.data(using: .utf8)!
    let envelope = try decoder.decode(CategoryListResponseDTO.self, from: data)
    let categories = envelope.toDomain()

    XCTAssertEqual(categories.count, 3)
    XCTAssertEqual(categories[0].slug, "flower")
    XCTAssertEqual(categories[1].slug, "indoor-flower")
    XCTAssertEqual(categories[1].parentId, categories[0].id)
    XCTAssertNil(categories[0].parentId)
    XCTAssertEqual(categories[0].displayOrder, 1)
    XCTAssertEqual(categories[2].iconKey, "categories/vape.svg")
  }

  func test_category_rejectsMalformedID() throws {
    let bad = """
    {
      "id": "not-a-uuid",
      "slug": "broken",
      "displayName": "Broken",
      "parentId": null,
      "displayOrder": 1,
      "iconKey": null
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(CategoryDTO.self, from: bad)
    XCTAssertNil(dto.toDomain())
  }

  func test_category_rejectsMalformedParentID() throws {
    let bad = """
    {
      "id": "0190B7A6-CAFE-72F5-A6B0-1C6F77CE0001",
      "slug": "broken",
      "displayName": "Broken",
      "parentId": "not-a-uuid",
      "displayOrder": 1,
      "iconKey": null
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(CategoryDTO.self, from: bad)
    XCTAssertNil(dto.toDomain())
  }

  // MARK: - Fixtures

  private static let listJSON = """
  {
    "categories": [
      {
        "id": "0190B7A6-CAFE-72F5-A6B0-1C6F77CE0001",
        "slug": "flower",
        "displayName": "Flower",
        "parentId": null,
        "displayOrder": 1,
        "iconKey": "categories/flower.svg"
      },
      {
        "id": "0190B7A6-CAFE-72F5-A6B0-1C6F77CE0011",
        "slug": "indoor-flower",
        "displayName": "Indoor Flower",
        "parentId": "0190B7A6-CAFE-72F5-A6B0-1C6F77CE0001",
        "displayOrder": 2,
        "iconKey": null
      },
      {
        "id": "0190B7A6-CAFE-72F5-A6B0-1C6F77CE0002",
        "slug": "vape",
        "displayName": "Vape",
        "parentId": null,
        "displayOrder": 3,
        "iconKey": "categories/vape.svg"
      }
    ]
  }
  """
}
