import XCTest
import DankDashDomain
@testable import DankDashNetwork

final class SearchDTODecodingTests: XCTestCase {
  private let decoder = JSONDecoder()

  func test_searchResponse_decodesResultsAndFacets() throws {
    let data = Self.responseJSON.data(using: .utf8)!
    let dto = try decoder.decode(SearchProductsResponseDTO.self, from: data)
    let domain = dto.toDomain()

    XCTAssertEqual(domain.results.count, 2)
    XCTAssertEqual(domain.results.first?.brand, "DankCo")
    XCTAssertEqual(domain.results.first?.thcMgPerUnit, Decimal(string: "875.00"))
    XCTAssertEqual(domain.results.first?.strainType, .hybrid)

    XCTAssertEqual(domain.categoryFacets.count, 2)
    XCTAssertEqual(domain.categoryFacets.first?.count, 12)
    XCTAssertEqual(
      domain.categoryFacets.first?.categoryId,
      UUID(uuidString: "0190B7A6-CAFE-72F5-A6B0-1C6F77CE0001")
    )

    XCTAssertEqual(domain.strainTypeFacets.count, 3)
    XCTAssertEqual(domain.strainTypeFacets.first?.strainType, .indica)
    XCTAssertEqual(domain.strainTypeFacets.first?.count, 7)

    XCTAssertEqual(domain.page.limit, 24)
    XCTAssertEqual(domain.page.offset, 0)
    XCTAssertEqual(domain.page.total, 41)
    XCTAssertTrue(domain.page.hasNextPage)
  }

  func test_searchResponse_droppingMalformedStrainFacet() throws {
    let bad = Self.responseJSON.replacingOccurrences(
      of: "\"strainType\": \"sativa\"",
      with: "\"strainType\": \"unicorn\""
    )
    let dto = try decoder.decode(SearchProductsResponseDTO.self, from: bad.data(using: .utf8)!)
    let domain = dto.toDomain()
    XCTAssertEqual(domain.strainTypeFacets.count, 2, "malformed strain facet drops")
  }

  func test_searchQuery_omitsEmptyAndDefaultsLimitOffset() {
    let q = SearchProductsQuery()
    let items = q.queryItems
    XCTAssertFalse(items.contains { $0.name == "q" })
    XCTAssertFalse(items.contains { $0.name == "category" })
    XCTAssertFalse(items.contains { $0.name == "strain_type" })
    XCTAssertEqual(items.first { $0.name == "limit" }?.value, "24")
    XCTAssertEqual(items.first { $0.name == "offset" }?.value, "0")
  }

  func test_searchQuery_renderEveryFilter() throws {
    let categoryID = try XCTUnwrap(UUID(uuidString: "0190B7A6-CAFE-72F5-A6B0-1C6F77CE0001"))
    let dispensaryID = try XCTUnwrap(UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0001"))
    let q = SearchProductsQuery(
      q: "diesel",
      categoryId: categoryID,
      strainType: .sativa,
      dispensaryId: dispensaryID,
      limit: 12,
      offset: 24
    )
    let map = Dictionary(uniqueKeysWithValues: q.queryItems.map { ($0.name, $0.value) })
    XCTAssertEqual(map["q"], "diesel")
    XCTAssertEqual(map["category"], categoryID.uuidString.lowercased())
    XCTAssertEqual(map["strain_type"], "sativa")
    XCTAssertEqual(map["dispensary_id"], dispensaryID.uuidString.lowercased())
    XCTAssertEqual(map["limit"], "12")
    XCTAssertEqual(map["offset"], "24")
  }

  func test_searchPage_hasNextPage_returnsFalseAtLastPage() {
    let page = SearchPage(limit: 24, offset: 24, total: 48)
    XCTAssertFalse(page.hasNextPage)
  }

  // MARK: - Fixtures

  private static let responseJSON = """
  {
    "results": [
      {
        "id": "0190B7A6-1100-72F5-A6B0-1C6F77CE0001",
        "categoryId": "0190B7A6-CAFE-72F5-A6B0-1C6F77CE0001",
        "brand": "DankCo",
        "name": "Gorilla Glue #4 3.5g",
        "productType": "flower",
        "strainType": "hybrid",
        "thcMgPerUnit": "875.00",
        "cbdMgPerUnit": "12.50",
        "weightGramsPerUnit": "3.50",
        "servingCount": null,
        "thcMgPerServing": null,
        "imageKeys": ["products/gg4/0.jpg"],
        "effectsTags": ["relaxed"],
        "flavorTags": ["earthy"]
      },
      {
        "id": "0190B7A6-2200-72F5-A6B0-1C6F77CE0002",
        "categoryId": "0190B7A6-CAFE-72F5-A6B0-1C6F77CE0002",
        "brand": "Stiiizy",
        "name": "Sour Diesel Pod 1g",
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
    ],
    "facets": {
      "categories": [
        { "categoryId": "0190B7A6-CAFE-72F5-A6B0-1C6F77CE0001", "count": 12 },
        { "categoryId": "0190B7A6-CAFE-72F5-A6B0-1C6F77CE0002", "count": 5 }
      ],
      "strainTypes": [
        { "strainType": "indica", "count": 7 },
        { "strainType": "sativa", "count": 6 },
        { "strainType": "hybrid", "count": 11 }
      ]
    },
    "page": { "limit": 24, "offset": 0, "total": 41 }
  }
  """
}
