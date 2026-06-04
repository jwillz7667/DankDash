import XCTest
import Foundation
import DankDashDomain
@testable import DankDashFeatures

final class MenuFilterTests: XCTestCase {
  func test_defaultFilter_isInactive() {
    XCTAssertFalse(MenuFilter().isActive)
    XCTAssertFalse(MenuFilter.none.isActive)
  }

  func test_emptyStrainTypes_passesAllProducts() {
    let filter = MenuFilter()
    let items = [Self.sample(strain: .indica), Self.sample(strain: .sativa)]
    XCTAssertEqual(filter.apply(to: items).count, 2)
  }

  func test_strainTypes_narrowsToMatchingProducts() {
    let filter = MenuFilter(strainTypes: [.indica, .hybrid])
    let items = [
      Self.sample(strain: .indica),
      Self.sample(strain: .sativa),
      Self.sample(strain: .hybrid),
      Self.sample(strain: nil),
    ]
    let result = filter.apply(to: items)
    XCTAssertEqual(result.count, 2)
  }

  func test_strainTypes_excludesProductsWithNilStrain() {
    let filter = MenuFilter(strainTypes: [.indica])
    let items = [Self.sample(strain: nil)]
    XCTAssertEqual(filter.apply(to: items).count, 0, "nil strain doesn't match any specific selection.")
  }

  func test_priceRange_narrowsByPriceCents() {
    let filter = MenuFilter(priceRangeCents: 2000...5000)
    let items = [
      Self.sample(priceCents: 1500), // below
      Self.sample(priceCents: 3000), // in
      Self.sample(priceCents: 5000), // upper inclusive
      Self.sample(priceCents: 6000), // above
    ]
    let result = filter.apply(to: items)
    XCTAssertEqual(result.map(\.priceCents), [3000, 5000])
  }

  func test_thcRange_narrowsByThcMgPerUnit() {
    let filter = MenuFilter(thcMgRange: Decimal(50)...Decimal(150))
    let items = [
      Self.sample(thcMgPerUnit: 25),
      Self.sample(thcMgPerUnit: 50),
      Self.sample(thcMgPerUnit: 100),
      Self.sample(thcMgPerUnit: 150),
      Self.sample(thcMgPerUnit: 200),
    ]
    let result = filter.apply(to: items)
    XCTAssertEqual(result.count, 3)
  }

  func test_effects_requireAnyIntersection() {
    let filter = MenuFilter(effects: ["relaxing", "creative"])
    let items = [
      Self.sample(effects: ["relaxing"]),
      Self.sample(effects: ["energetic"]),
      Self.sample(effects: ["relaxing", "creative"]),
      Self.sample(effects: []),
    ]
    let result = filter.apply(to: items)
    XCTAssertEqual(result.count, 2)
  }

  func test_combinedFilters_areConjunctive() {
    let filter = MenuFilter(
      strainTypes: [.indica],
      priceRangeCents: 1000...5000,
      thcMgRange: Decimal(50)...Decimal(200),
      effects: ["calm"]
    )
    let items = [
      Self.sample(strain: .indica, priceCents: 3000, thcMgPerUnit: 100, effects: ["calm"]), // pass
      Self.sample(strain: .sativa, priceCents: 3000, thcMgPerUnit: 100, effects: ["calm"]), // wrong strain
      Self.sample(strain: .indica, priceCents: 9999, thcMgPerUnit: 100, effects: ["calm"]), // price too high
      Self.sample(strain: .indica, priceCents: 3000, thcMgPerUnit: 300, effects: ["calm"]), // THC too high
      Self.sample(strain: .indica, priceCents: 3000, thcMgPerUnit: 100, effects: ["focus"]), // wrong effect
    ]
    let result = filter.apply(to: items)
    XCTAssertEqual(result.count, 1)
  }

  func test_isActive_reflectsAnyConstraint() {
    XCTAssertTrue(MenuFilter(strainTypes: [.indica]).isActive)
    XCTAssertTrue(MenuFilter(priceRangeCents: 1...2).isActive)
    XCTAssertTrue(MenuFilter(thcMgRange: 1...2).isActive)
    XCTAssertTrue(MenuFilter(effects: ["x"]).isActive)
    XCTAssertFalse(MenuFilter(
      strainTypes: [],
      priceRangeCents: nil,
      thcMgRange: nil,
      effects: []
    ).isActive)
  }

  // MARK: - helpers

  static func sample(
    strain: StrainType? = .hybrid,
    priceCents: Int = 3000,
    thcMgPerUnit: Decimal = 100,
    effects: [String] = []
  ) -> MenuItem {
    let product = MenuProductSummary(
      id: UUID(),
      categoryId: UUID(),
      brand: "B",
      name: "P",
      description: nil,
      productType: .flower,
      strainType: strain,
      thcMgPerUnit: thcMgPerUnit,
      cbdMgPerUnit: 0,
      weightGramsPerUnit: 1,
      servingCount: nil,
      thcMgPerServing: nil,
      imageKeys: [],
      effectsTags: effects,
      flavorTags: []
    )
    return MenuItem(
      listingId: UUID(),
      sku: "SKU",
      priceCents: priceCents,
      compareAtPriceCents: nil,
      quantityAvailable: 10,
      product: product
    )
  }
}
