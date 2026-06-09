import XCTest
import Foundation
import SwiftUI
import DankDashDomain
@testable import DankDashDesignSystem

/// Smoke tests for the Phase 18 cart / order / compliance components.
/// Same intent as the Phase 16 + 17 suites: catch initializer-signature
/// regressions and confirm every public variant compiles and
/// instantiates without trapping. Static helpers get exact-output
/// assertions; rendering is covered by `XCTAssertNotNil(body)`.
@MainActor
final class Phase18ComponentSmokeTests: XCTestCase {

  // MARK: - QuantityStepper

  func test_quantityStepper_canDecrementAndIncrementGuards() {
    let mid = QuantityStepper(quantity: 3, maxQuantity: 10, onIncrement: {}, onDecrement: {})
    XCTAssertTrue(mid.canIncrement)
    XCTAssertTrue(mid.canDecrement)
    XCTAssertNotNil(mid.body)

    let floor = QuantityStepper(quantity: 0, maxQuantity: 10, onIncrement: {}, onDecrement: {})
    XCTAssertTrue(floor.canIncrement)
    XCTAssertFalse(floor.canDecrement)
    XCTAssertNotNil(floor.body)

    let cap = QuantityStepper(quantity: 10, maxQuantity: 10, onIncrement: {}, onDecrement: {})
    XCTAssertFalse(cap.canIncrement)
    XCTAssertTrue(cap.canDecrement)
    XCTAssertNotNil(cap.body)

    let stuck = QuantityStepper(quantity: 0, maxQuantity: 0, onIncrement: {}, onDecrement: {})
    XCTAssertFalse(stuck.canIncrement)
    XCTAssertFalse(stuck.canDecrement)
  }

  // MARK: - OrderStatusPill

  func test_orderStatusPill_labelsCoverAllCases() {
    for status in OrderStatus.allCases {
      let label = OrderStatusPill.label(for: status)
      XCTAssertFalse(label.isEmpty, "missing label for \(status)")
    }
  }

  func test_orderStatusPill_toneBuckets() {
    XCTAssertEqual(OrderStatusPill.tone(for: .placed), .info)
    XCTAssertEqual(OrderStatusPill.tone(for: .driverAssigned), .progress)
    XCTAssertEqual(OrderStatusPill.tone(for: .delivered), .success)
    XCTAssertEqual(OrderStatusPill.tone(for: .idScanPassed), .success)
    XCTAssertEqual(OrderStatusPill.tone(for: .paymentFailed), .danger)
    XCTAssertEqual(OrderStatusPill.tone(for: .rejected), .danger)
    XCTAssertEqual(OrderStatusPill.tone(for: .canceled), .danger)
    XCTAssertEqual(OrderStatusPill.tone(for: .disputed), .danger)
  }

  func test_orderStatusPill_rendersEveryStatus() {
    for status in OrderStatus.allCases {
      XCTAssertNotNil(OrderStatusPill(status: status).body)
    }
  }

  // MARK: - ComplianceProgressBar

  func test_complianceProgressBar_ratioClampsTo0to1() {
    let zero = ComplianceProgressBar(title: "Flower", current: 0, max: 56.7, unit: "g")
    XCTAssertEqual(zero.ratio, 0, accuracy: 0.0001)
    XCTAssertEqual(zero.tone, .calm)

    let half = ComplianceProgressBar(title: "Flower", current: 28.35, max: 56.7, unit: "g")
    XCTAssertEqual(half.ratio, 0.5, accuracy: 0.0001)
    XCTAssertEqual(half.tone, .calm)

    let nearCap = ComplianceProgressBar(title: "Flower", current: 50, max: 56.7, unit: "g")
    XCTAssertTrue(nearCap.ratio > 0.85 && nearCap.ratio < 0.95)
    XCTAssertEqual(nearCap.tone, .warn)

    let atCap = ComplianceProgressBar(title: "Flower", current: 56.7, max: 56.7, unit: "g")
    XCTAssertEqual(atCap.ratio, 1, accuracy: 0.0001)
    XCTAssertEqual(atCap.tone, .alert)

    let over = ComplianceProgressBar(title: "Flower", current: 70, max: 56.7, unit: "g")
    XCTAssertEqual(over.ratio, 1, accuracy: 0.0001, "ratio must clamp to 1 on overflow")
    XCTAssertEqual(over.tone, .alert)

    let degenerate = ComplianceProgressBar(title: "Flower", current: 5, max: 0, unit: "g")
    XCTAssertEqual(degenerate.ratio, 0, accuracy: 0.0001, "zero max yields zero ratio")
  }

  func test_complianceProgressBar_formatRoundsToOneDecimal() {
    XCTAssertEqual(ComplianceProgressBar.format(Decimal(string: "12.345")!), "12.3")
    XCTAssertEqual(ComplianceProgressBar.format(Decimal(0)), "0")
    XCTAssertEqual(ComplianceProgressBar.format(Decimal(string: "56.7")!), "56.7")
  }

  func test_complianceProgressBar_rendersAllTones() {
    XCTAssertNotNil(ComplianceProgressBar(title: "Flower", current: 5, max: 56.7, unit: "g").body)
    XCTAssertNotNil(ComplianceProgressBar(title: "Flower", current: 50, max: 56.7, unit: "g").body)
    XCTAssertNotNil(ComplianceProgressBar(title: "Flower", current: 56, max: 56.7, unit: "g").body)
  }

  // MARK: - ComplianceSummaryBanner

  func test_complianceSummaryBanner_passingEvaluation() {
    let evaluation = Self.evaluation(passed: true, overLimit: false)
    XCTAssertNotNil(ComplianceSummaryBanner(evaluation: evaluation).body)
  }

  func test_complianceSummaryBanner_overLimitFailure() {
    let evaluation = Self.evaluation(passed: false, overLimit: true)
    XCTAssertNotNil(ComplianceSummaryBanner(evaluation: evaluation).body)
  }

  func test_complianceSummaryBanner_nonLimitFailureStillRenders() {
    let evaluation = Self.evaluation(passed: false, overLimit: false)
    XCTAssertNotNil(ComplianceSummaryBanner(evaluation: evaluation).body)
  }

  // MARK: - LineItemRow

  func test_lineItemRow_rendersWithAndWithoutImage() {
    let withImage = LineItemRow(
      listingId: UUID(),
      productName: "Gorilla Glue #4 3.5g",
      brand: "DankCo",
      imageKey: "products/x/0.jpg",
      cdnBaseURL: URL(string: "https://cdn.example"),
      unitPriceCents: 4500,
      lineSubtotalCents: 9000,
      quantity: 2,
      maxQuantity: 10,
      onIncrement: {},
      onDecrement: {}
    )
    XCTAssertNotNil(withImage.body)

    let withoutImage = LineItemRow(
      listingId: UUID(),
      productName: "Wedding Cake",
      brand: "Highline",
      imageKey: nil,
      cdnBaseURL: nil,
      unitPriceCents: 6500,
      lineSubtotalCents: 6500,
      quantity: 1,
      maxQuantity: 5,
      isPending: true,
      onIncrement: {},
      onDecrement: {}
    )
    XCTAssertNotNil(withoutImage.body)
  }

  func test_lineItemRow_formatPriceMatchesUSD() {
    XCTAssertEqual(LineItemRow.formatPrice(4500), "$45.00")
    XCTAssertEqual(LineItemRow.formatPrice(99), "$0.99")
    XCTAssertEqual(LineItemRow.formatPrice(0), "$0.00")
  }

  // MARK: - CartExpiryBanner

  func test_cartExpiryBanner_toneTransitions() {
    XCTAssertNil(CartExpiryBanner(remaining: 600).displayTone, "hidden when > 5 min")
    XCTAssertEqual(CartExpiryBanner(remaining: 240).displayTone, .warning)
    XCTAssertEqual(CartExpiryBanner(remaining: 60).displayTone, .warning)
    XCTAssertEqual(CartExpiryBanner(remaining: 59).displayTone, .critical)
    XCTAssertEqual(CartExpiryBanner(remaining: 0).displayTone, .critical)
    XCTAssertEqual(CartExpiryBanner(remaining: -10).displayTone, .expired)
  }

  func test_cartExpiryBanner_rendersWhenVisible() {
    XCTAssertNotNil(CartExpiryBanner(remaining: 240).body)
    XCTAssertNotNil(CartExpiryBanner(remaining: 30).body)
    XCTAssertNotNil(CartExpiryBanner(remaining: -1).body)
    XCTAssertNotNil(CartExpiryBanner(remaining: 1000).body)
  }

  // MARK: - AddressRow

  func test_addressRow_allAccessoriesRender() {
    let addr = Self.address
    XCTAssertNotNil(AddressRow(address: addr, accessory: .none).body)
    XCTAssertNotNil(AddressRow(address: addr, accessory: .chevron, action: {}).body)
    XCTAssertNotNil(AddressRow(address: addr, accessory: .selected, action: {}).body)
  }

  func test_addressRow_handlesEmptyAndCustomLabels() {
    let work = Self.address(label: "Work", isDefault: false, isValidated: true)
    let unlabeled = Self.address(label: nil, isDefault: false, isValidated: true)
    let invalid = Self.address(label: "Home", isDefault: true, isValidated: false)
    XCTAssertNotNil(AddressRow(address: work).body)
    XCTAssertNotNil(AddressRow(address: unlabeled).body)
    XCTAssertNotNil(AddressRow(address: invalid).body)
  }

  // MARK: - OrderListRow

  func test_orderListRow_relativeLabelBuckets() {
    let now = Date(timeIntervalSince1970: 1_780_000_000)
    XCTAssertEqual(
      OrderListRow.relativeLabel(now.addingTimeInterval(-30), now: now),
      "just now"
    )
    XCTAssertEqual(
      OrderListRow.relativeLabel(now.addingTimeInterval(-12 * 60), now: now),
      "12m ago"
    )
    XCTAssertEqual(
      OrderListRow.relativeLabel(now.addingTimeInterval(-5 * 3600), now: now),
      "5h ago"
    )
    let twoDaysAgo = now.addingTimeInterval(-2 * 86_400)
    let twoDaysLabel = OrderListRow.relativeLabel(twoDaysAgo, now: now)
    XCTAssertFalse(twoDaysLabel.isEmpty)
    XCTAssertFalse(twoDaysLabel.hasSuffix(" ago"))
  }

  func test_orderListRow_formatPriceMatchesUSD() {
    XCTAssertEqual(OrderListRow.formatPrice(5550), "$55.50")
    XCTAssertEqual(OrderListRow.formatPrice(0), "$0.00")
  }

  func test_orderListRow_rendersWithDispensaryNameOrNot() {
    let item = OrderListItem(
      id: UUID(),
      shortCode: "DD-ABC123",
      dispensaryId: UUID(),
      status: .enRouteDropoff,
      totalCents: 5550,
      placedAt: Date(timeIntervalSinceNow: -600),
      statusChangedAt: Date()
    )
    XCTAssertNotNil(OrderListRow(item: item, dispensaryName: "Greenleaf Co-op", action: {}).body)
    XCTAssertNotNil(OrderListRow(item: item, dispensaryName: nil, action: {}).body)
  }

  // MARK: - CheckoutCTAButton

  func test_checkoutCTAButton_allStatesRender() {
    XCTAssertNotNil(CheckoutCTAButton(action: {}).body)
    XCTAssertNotNil(CheckoutCTAButton(isLoading: true, action: {}).body)
    XCTAssertNotNil(CheckoutCTAButton(isEnabled: false, action: {}).body)
    XCTAssertNotNil(CheckoutCTAButton(isLoading: true, isEnabled: false, action: {}).body)
  }

  // MARK: - DriverCard

  func test_driverCard_allVariantsRender() {
    let full = DriverPublicProfile(
      id: UUID(),
      displayName: "Sam Driver",
      avatarKey: "drivers/sam.jpg",
      vehicleSummary: "Blue 2021 Honda Civic",
      maskedPhone: "+1 ••• ••• 1234"
    )
    XCTAssertNotNil(
      DriverCard(driver: full, cdnBaseURL: URL(string: "https://cdn.example"), onCall: {}).body
    )

    let initialsOnly = DriverPublicProfile(
      id: UUID(),
      displayName: "Anonymous",
      avatarKey: nil,
      vehicleSummary: nil,
      maskedPhone: nil
    )
    XCTAssertNotNil(DriverCard(driver: initialsOnly, cdnBaseURL: nil).body)

    // onCall present but no phone — the call button should be omitted but the
    // view still renders fine.
    let phoneless = DriverPublicProfile(
      id: UUID(),
      displayName: "Quiet Driver",
      avatarKey: nil,
      vehicleSummary: "Red 2018 Toyota Prius",
      maskedPhone: nil
    )
    XCTAssertNotNil(DriverCard(driver: phoneless, cdnBaseURL: nil, onCall: {}).body)
  }

  // MARK: - OrderStatusTimeline

  func test_orderStatusTimeline_milestoneMapping() {
    XCTAssertEqual(OrderStatusTimeline.milestone(for: .placed), .placed)
    XCTAssertEqual(OrderStatusTimeline.milestone(for: .accepted), .preparing)
    XCTAssertEqual(OrderStatusTimeline.milestone(for: .prepping), .preparing)
    XCTAssertEqual(OrderStatusTimeline.milestone(for: .readyForPickup), .preparing)
    XCTAssertEqual(OrderStatusTimeline.milestone(for: .awaitingDriver), .driverAssigned)
    XCTAssertEqual(OrderStatusTimeline.milestone(for: .driverAssigned), .driverAssigned)
    XCTAssertEqual(OrderStatusTimeline.milestone(for: .enRoutePickup), .onTheWay)
    XCTAssertEqual(OrderStatusTimeline.milestone(for: .pickedUp), .onTheWay)
    XCTAssertEqual(OrderStatusTimeline.milestone(for: .enRouteDropoff), .onTheWay)
    XCTAssertEqual(OrderStatusTimeline.milestone(for: .arrivedAtDropoff), .arriving)
    XCTAssertEqual(OrderStatusTimeline.milestone(for: .idScanPending), .arriving)
    XCTAssertEqual(OrderStatusTimeline.milestone(for: .idScanPassed), .arriving)
    XCTAssertEqual(OrderStatusTimeline.milestone(for: .delivered), .delivered)
  }

  func test_orderStatusTimeline_rendersEveryStatus() {
    for status in OrderStatus.allCases {
      XCTAssertNotNil(OrderStatusTimeline(status: status).body, "failed for \(status)")
    }
  }

  // MARK: - LiveMapView

  func test_liveMapView_rendersWithAndWithoutDriver() {
    let dispensary = LiveMapView.Pin(
      id: "dispensary",
      kind: .dispensary,
      coordinate: Coordinate(latitude: 44.95, longitude: -93.10),
      title: "Greenleaf"
    )
    let customer = LiveMapView.Pin(
      id: "customer",
      kind: .customer,
      coordinate: Coordinate(latitude: 44.96, longitude: -93.12),
      title: "Home"
    )
    let driver = LiveMapView.Pin(
      id: "driver",
      kind: .driver,
      coordinate: Coordinate(latitude: 44.955, longitude: -93.11),
      title: "Sam"
    )
    XCTAssertNotNil(LiveMapView(dispensary: dispensary, customer: customer, driver: driver).body)
    XCTAssertNotNil(LiveMapView(dispensary: dispensary, customer: customer, driver: nil).body)
    XCTAssertNotNil(LiveMapView(dispensary: nil, customer: customer, driver: nil).body)

    // Driver-app variant: both the active leg and the dispensary → drop-off
    // preview leg supplied.
    let activeLeg = [driver.coordinate, dispensary.coordinate]
    let previewLeg = [dispensary.coordinate, customer.coordinate]
    XCTAssertNotNil(
      LiveMapView(
        dispensary: dispensary,
        customer: customer,
        driver: driver,
        route: activeLeg,
        deliveryLeg: previewLeg
      ).body
    )
    // A single-point leg must not draw a polyline — exercises the count >= 2 guard.
    XCTAssertNotNil(
      LiveMapView(
        dispensary: dispensary,
        customer: customer,
        driver: driver,
        route: [driver.coordinate],
        deliveryLeg: nil
      ).body
    )
  }

  // MARK: - DeliveryDetailsCard

  func test_deliveryDetailsCard_rendersWithAndWithoutTip() {
    XCTAssertNotNil(
      DeliveryDetailsCard(
        orderShortCode: "ABC123",
        itemSummary: "Blue Dream 1/8 ×2 · Sour Gummies ×1",
        itemCount: 3,
        tipCents: 850
      ).body
    )
    XCTAssertNotNil(
      DeliveryDetailsCard(
        orderShortCode: "ZZZ999",
        itemSummary: nil,
        itemCount: 1,
        tipCents: 0
      ).body
    )
  }

  func test_deliveryDetailsCard_formatPriceMatchesUSD() {
    XCTAssertEqual(DeliveryDetailsCard.formatPrice(850), "$8.50")
    XCTAssertEqual(DeliveryDetailsCard.formatPrice(0), "$0.00")
    XCTAssertEqual(DeliveryDetailsCard.formatPrice(1234), "$12.34")
  }

  // MARK: - RatingSheet

  func test_ratingSheet_rendersAcrossRatingsAndStates() {
    @State var rating0: Int = 0
    @State var rating5: Int = 5
    @State var emptyComment: String = ""
    @State var filledComment: String = "Driver was prompt."

    XCTAssertNotNil(
      RatingSheet(
        rating: Binding(get: { rating0 }, set: { rating0 = $0 }),
        comment: Binding(get: { emptyComment }, set: { emptyComment = $0 }),
        onSubmit: {},
        onSkip: {}
      ).body
    )
    XCTAssertNotNil(
      RatingSheet(
        rating: Binding(get: { rating5 }, set: { rating5 = $0 }),
        comment: Binding(get: { filledComment }, set: { filledComment = $0 }),
        isSubmitting: true,
        onSubmit: {},
        onSkip: {}
      ).body
    )
    XCTAssertNotNil(
      RatingSheet(
        rating: Binding(get: { rating5 }, set: { rating5 = $0 }),
        comment: Binding(get: { filledComment }, set: { filledComment = $0 }),
        isSubmitting: false,
        errorMessage: "Couldn't submit rating. Try again.",
        onSubmit: {},
        onSkip: {}
      ).body
    )
  }

  // MARK: - Fixtures

  private static var address: UserAddress {
    Self.address(label: "Home", isDefault: true, isValidated: true)
  }

  private static func address(label: String?, isDefault: Bool, isValidated: Bool) -> UserAddress {
    UserAddress(
      id: UUID(),
      label: label,
      line1: "1100 Hennepin Ave",
      line2: "Apt 204",
      city: "Minneapolis",
      region: "MN",
      postalCode: "55403",
      country: "US",
      location: Coordinate(latitude: 44.9778, longitude: -93.2650),
      isDefault: isDefault,
      isValidated: isValidated,
      validatedAt: isValidated ? Date() : nil,
      deliveryInstructions: "Buzz #204",
      createdAt: Date(),
      updatedAt: Date()
    )
  }

  /// Builds a ComplianceEvaluation with a deliberate over-limit (or not)
  /// per-transaction rule. `overLimit == false && passed == false` is
  /// the geofence-shaped failure where the picker can't fix it.
  private static func evaluation(passed: Bool, overLimit: Bool) -> ComplianceEvaluation {
    let perTxRule: RuleResult? = overLimit
      ? RuleResult(
          rule: .perTransactionLimit,
          passed: false,
          details: .object(["flowerGramsOver": .double(12.3)])
        )
      : nil
    let geofenceRule: RuleResult? = (!passed && !overLimit)
      ? RuleResult(
          rule: .deliveryGeofence,
          passed: false,
          details: .object([
            "latitude": .double(44.95),
            "longitude": .double(-93.10),
          ])
        )
      : nil
    let passingRule = RuleResult(
      rule: .perTransactionLimit,
      passed: true,
      details: .null
    )
    let rules: [RuleResult] = {
      var r: [RuleResult] = []
      if let perTxRule { r.append(perTxRule) } else if passed { r.append(passingRule) }
      if let geofenceRule { r.append(geofenceRule) }
      return r
    }()
    return ComplianceEvaluation(
      passed: passed,
      rules: rules,
      cartTotals: ComplianceTotals(
        flowerGrams: overLimit ? Decimal(string: "70")! : Decimal(string: "12.3")!,
        concentrateGrams: Decimal(string: "0.5")!,
        edibleThcMg: Decimal(string: "150")!
      ),
      limits: ComplianceLimits(
        flowerGramsMax: Decimal(string: "56.7")!,
        concentrateGramsMax: Decimal(string: "8")!,
        edibleThcMgMax: Decimal(string: "800")!
      ),
      evaluatedAt: Date(timeIntervalSince1970: 1_780_000_000),
      evaluationVersion: "1.0.0"
    )
  }
}
