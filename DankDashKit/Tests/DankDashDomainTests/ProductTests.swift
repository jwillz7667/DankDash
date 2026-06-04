import XCTest
@testable import DankDashDomain

final class ProductTests: XCTestCase {
  private let fixed = Date(timeIntervalSince1970: 1_700_000_000)

  private func make(labResults: [LabResult] = []) -> Product {
    Product(
      id: UUID(),
      categoryId: UUID(),
      brand: "Test Co",
      name: "Sour Diesel — 1g preroll",
      description: "Test description",
      productType: .preroll,
      strainType: .sativa,
      thcMgPerUnit: Decimal(string: "210.50")!,
      cbdMgPerUnit: Decimal(string: "1.20")!,
      weightGramsPerUnit: Decimal(string: "1.000")!,
      servingCount: nil,
      thcMgPerServing: nil,
      imageKeys: ["product/abc/0.jpg"],
      effectsTags: ["focused", "uplifted"],
      flavorTags: ["citrus"],
      createdAt: fixed,
      updatedAt: fixed,
      labResults: labResults
    )
  }

  func test_decimalsPreservePrecision() {
    let product = make()
    // Decimal arithmetic preserves precision even when description strips
    // trailing zeros — verify via numeric equality, which is what
    // compliance math cares about.
    XCTAssertEqual(product.thcMgPerUnit, Decimal(string: "210.50"))
    XCTAssertEqual(product.cbdMgPerUnit, Decimal(string: "1.2"))
    XCTAssertEqual(product.weightGramsPerUnit, Decimal(string: "1"))
    XCTAssertEqual(product.thcMgPerUnit - Decimal(string: "210.5")!, .zero)
  }

  func test_headlineLabResultIsFirst() {
    let newest = LabResult(
      id: UUID(),
      batchId: "B-002",
      labName: "Test Lab",
      coaDocumentKey: nil,
      potencyThc: Decimal(string: "21.5"),
      potencyCbd: nil,
      contaminantsPassed: true,
      testedAt: "2026-03-01"
    )
    let older = LabResult(
      id: UUID(),
      batchId: "B-001",
      labName: "Test Lab",
      coaDocumentKey: nil,
      potencyThc: Decimal(string: "20.0"),
      potencyCbd: nil,
      contaminantsPassed: true,
      testedAt: "2026-01-01"
    )
    let product = make(labResults: [newest, older])
    XCTAssertEqual(product.headlineLabResult?.batchId, "B-002")
  }

  func test_headlineLabResultIsNilWhenNoResults() {
    XCTAssertNil(make().headlineLabResult)
  }

  func test_menuItemSubtotalAndStockFlags() {
    let product = MenuProductSummary(
      id: UUID(),
      categoryId: UUID(),
      brand: "Brand",
      name: "Edible",
      description: nil,
      productType: .edible,
      strainType: .hybrid,
      thcMgPerUnit: Decimal(string: "10")!,
      cbdMgPerUnit: Decimal(string: "0")!,
      weightGramsPerUnit: Decimal(string: "5")!,
      servingCount: 2,
      thcMgPerServing: Decimal(string: "5")!,
      imageKeys: [],
      effectsTags: [],
      flavorTags: []
    )
    let menu = MenuItem(
      listingId: UUID(),
      sku: "SKU-1",
      priceCents: 1500,
      compareAtPriceCents: 2000,
      quantityAvailable: 8,
      product: product
    )
    XCTAssertTrue(menu.isInStock)
    XCTAssertTrue(menu.isOnSale)

    let outOfStock = MenuItem(
      listingId: UUID(),
      sku: "SKU-2",
      priceCents: 1500,
      compareAtPriceCents: nil,
      quantityAvailable: 0,
      product: product
    )
    XCTAssertFalse(outOfStock.isInStock)
    XCTAssertFalse(outOfStock.isOnSale)
  }
}
