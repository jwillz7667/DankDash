import XCTest
import Foundation
import SwiftUI
import DankDashDomain
@testable import DankDashDesignSystem

/// Smoke tests for the Phase 17 catalog components. Same intent as
/// ComponentSmokeTests: catch initializer-signature regressions and
/// confirm every public variant compiles and instantiates without
/// trapping. Pixel-level snapshots require a UIKit host and live in the
/// iOS app target.
@MainActor
final class CatalogComponentSmokeTests: XCTestCase {
  func test_sectionHeader_allVariantsRender() {
    XCTAssertNotNil(SectionHeader(title: "Title").body)
    XCTAssertNotNil(SectionHeader(eyebrow: "Eyebrow", title: "Title").body)
    XCTAssertNotNil(
      SectionHeader(eyebrow: "Eyebrow", title: "Title", accessoryTitle: "See all", accessoryAction: {}).body
    )
  }

  func test_emptyState_withAndWithoutAction() {
    XCTAssertNotNil(
      EmptyStateView(systemImage: "leaf", title: "No results", message: "Try a different search.").body
    )
    XCTAssertNotNil(
      EmptyStateView(
        systemImage: "location.slash",
        title: "Turn on location",
        message: "We use it to show dispensaries near you.",
        actionTitle: "Enable",
        action: {}
      ).body
    )
  }

  func test_facetPill_selectedAndUnselected() {
    XCTAssertNotNil(FacetPill(title: "Indica", count: 12, isSelected: true, action: {}).body)
    XCTAssertNotNil(FacetPill(title: "Sativa", isSelected: false, action: {}).body)
  }

  func test_categoryTabBar_rendersWithSelection() {
    @State var selection: String? = "flower"
    let bar = CategoryTabBar(
      items: [
        .init(id: "flower", title: "Flower", count: 24),
        .init(id: "vape", title: "Vape", count: 9),
      ],
      selection: .constant("flower")
    )
    XCTAssertNotNil(bar.body)
  }

  func test_dankAsyncImage_handlesMissingURL() {
    let withKey = DankAsyncImage(imageKey: "x/y.jpg", cdnBaseURL: URL(string: "https://cdn.example"))
    let withoutKey = DankAsyncImage(imageKey: nil, cdnBaseURL: nil)
    XCTAssertNotNil(withKey.body)
    XCTAssertNotNil(withoutKey.body)
  }

  func test_dispensaryCard_openClosedAndEmptyHero() {
    let openCard = DispensaryCard(
      dispensary: Self.dispensary(open: true, withRating: true),
      cdnBaseURL: URL(string: "https://cdn.example"),
      etaHint: "20–30 min",
      action: {}
    )
    let closedNoHero = DispensaryCard(
      dispensary: Self.dispensary(open: false, withRating: false, heroKey: nil),
      cdnBaseURL: URL(string: "https://cdn.example"),
      action: {}
    )
    XCTAssertNotNil(openCard.body)
    XCTAssertNotNil(closedNoHero.body)
  }

  func test_productTile_strainVariantsAndPricing() {
    let onSale = ProductTile(
      menuItem: Self.menuItem(strain: .hybrid, priceCents: 4500, compareAtPriceCents: 5500, qty: 12),
      cdnBaseURL: URL(string: "https://cdn.example"),
      action: {}
    )
    let outOfStock = ProductTile(
      menuItem: Self.menuItem(strain: .indica, priceCents: 6500, compareAtPriceCents: nil, qty: 0),
      cdnBaseURL: URL(string: "https://cdn.example"),
      action: {}
    )
    let cbd = ProductTile(
      menuItem: Self.menuItem(strain: .cbd, priceCents: 2500, compareAtPriceCents: nil, qty: 5),
      cdnBaseURL: nil,
      action: {}
    )
    XCTAssertNotNil(onSale.body)
    XCTAssertNotNil(outOfStock.body)
    XCTAssertNotNil(cbd.body)
  }

  func test_productTile_strainTints_differForEveryCase() {
    var seen: Set<String> = []
    for strain in StrainType.allCases {
      let color = ProductTile.strainTint(strain)
      seen.insert(color.description)
    }
    XCTAssertEqual(seen.count, StrainType.allCases.count, "every strain renders a distinct tint")
  }

  func test_productTile_formatTHC_weightedRoundsToOneDecimal() {
    let result = ProductTile.formatTHC(Decimal(string: "875.00")!, weight: Decimal(string: "3.50")!)
    XCTAssertEqual(result, "25.0% THC")
  }

  func test_productTile_formatTHC_unweightedFallsBackToMg() {
    let result = ProductTile.formatTHC(Decimal(string: "100")!, weight: 0)
    XCTAssertEqual(result, "100 mg THC")
  }

  func test_productTile_formatPrice_centsToUSD() {
    XCTAssertEqual(ProductTile.formatPrice(4500), "$45.00")
    XCTAssertEqual(ProductTile.formatPrice(99), "$0.99")
  }

  // MARK: - Fixtures

  private static func dispensary(open: Bool, withRating: Bool, heroKey: String? = "stores/x.jpg") -> Dispensary {
    Dispensary(
      id: UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0001")!,
      legalName: "Greenleaf Cooperative LLC",
      dba: "Greenleaf",
      licenseNumber: "MN-RT-0001",
      licenseType: .retailer,
      addressLine1: "1 Main St",
      addressLine2: nil,
      city: "Saint Paul",
      region: "MN",
      postalCode: "55102",
      location: Coordinate(latitude: 44.95, longitude: -93.10),
      deliveryPolygon: GeoPolygon(rings: [[
        Coordinate(latitude: 44.95, longitude: -93.10),
        Coordinate(latitude: 44.96, longitude: -93.10),
        Coordinate(latitude: 44.96, longitude: -93.11),
        Coordinate(latitude: 44.95, longitude: -93.11),
        Coordinate(latitude: 44.95, longitude: -93.10),
      ]]),
      hours: DispensaryHours(
        mon: DayHours(openMinutes: 8 * 60, closeMinutes: 22 * 60),
        tue: DayHours(openMinutes: 8 * 60, closeMinutes: 22 * 60),
        wed: DayHours(openMinutes: 8 * 60, closeMinutes: 22 * 60),
        thu: DayHours(openMinutes: 8 * 60, closeMinutes: 22 * 60),
        fri: DayHours(openMinutes: 8 * 60, closeMinutes: 24 * 60),
        sat: DayHours(openMinutes: 8 * 60, closeMinutes: 24 * 60),
        sun: DayHours(openMinutes: 10 * 60, closeMinutes: 20 * 60)
      ),
      phone: nil,
      email: nil,
      logoImageKey: nil,
      heroImageKey: heroKey,
      brandColorHex: nil,
      isAcceptingOrders: true,
      isOpenNow: open,
      opensAt: open ? nil : Date(timeIntervalSince1970: 1_780_000_000),
      ratingAvg: withRating ? Decimal(string: "4.7") : nil,
      ratingCount: withRating ? 218 : 0,
      status: .active,
      createdAt: Date(timeIntervalSince1970: 1_770_000_000),
      updatedAt: Date(timeIntervalSince1970: 1_780_000_000)
    )
  }

  private static func menuItem(
    strain: StrainType,
    priceCents: Int,
    compareAtPriceCents: Int?,
    qty: Int
  ) -> MenuItem {
    MenuItem(
      listingId: UUID(),
      sku: "SKU-\(strain.rawValue)",
      priceCents: priceCents,
      compareAtPriceCents: compareAtPriceCents,
      quantityAvailable: qty,
      product: MenuProductSummary(
        id: UUID(),
        categoryId: UUID(),
        brand: "DankCo",
        name: "Gorilla Glue #4 3.5g",
        description: nil,
        productType: .flower,
        strainType: strain,
        thcMgPerUnit: Decimal(string: "875.00")!,
        cbdMgPerUnit: Decimal(string: "12.50")!,
        weightGramsPerUnit: Decimal(string: "3.50")!,
        servingCount: nil,
        thcMgPerServing: nil,
        imageKeys: ["products/x/0.jpg"],
        effectsTags: ["relaxed"],
        flavorTags: ["earthy"]
      )
    )
  }
}
