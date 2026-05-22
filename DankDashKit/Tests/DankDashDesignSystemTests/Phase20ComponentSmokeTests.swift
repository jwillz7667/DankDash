import XCTest
import Foundation
import SwiftUI
import DankDashDomain
@testable import DankDashDesignSystem

/// Smoke tests for the Phase 20 driver-facing DesignSystem components.
/// Same intent as the Phase 18/19 suites: catch initializer-signature
/// regressions, exercise every public variant, and pin the pure helper
/// outputs (tint mapping, countdown math, formatter parity) that the
/// driver reducers' UX depends on.
@MainActor
final class Phase20ComponentSmokeTests: XCTestCase {

  // MARK: - CountdownRingView

  func test_countdownRing_progressClampsAtBothEnds() {
    let zero = CountdownRingView(secondsRemaining: 0, totalSeconds: 30)
    XCTAssertEqual(zero.progress, 0)

    let full = CountdownRingView(secondsRemaining: 30, totalSeconds: 30)
    XCTAssertEqual(full.progress, 1)

    let overflow = CountdownRingView(secondsRemaining: 99, totalSeconds: 30)
    XCTAssertEqual(overflow.progress, 1, "secondsRemaining > totalSeconds clamps to 1")

    let negative = CountdownRingView(secondsRemaining: -5, totalSeconds: 30)
    XCTAssertEqual(negative.progress, 0, "negative seconds clamp to 0")
  }

  func test_countdownRing_labelRoundsUp() {
    XCTAssertEqual(CountdownRingView(secondsRemaining: 30, totalSeconds: 30).label, "30")
    XCTAssertEqual(CountdownRingView(secondsRemaining: 29.4, totalSeconds: 30).label, "30")
    XCTAssertEqual(CountdownRingView(secondsRemaining: 0.4, totalSeconds: 30).label, "1")
    XCTAssertEqual(CountdownRingView(secondsRemaining: 0, totalSeconds: 30).label, "0")
  }

  func test_countdownRing_tintBuckets() {
    // >=0.5 → primary, >=0.2 → warning, <0.2 → danger
    let safe = CountdownRingView(secondsRemaining: 20, totalSeconds: 30)
    XCTAssertEqual(safe.tint, DankColor.primary)

    let warning = CountdownRingView(secondsRemaining: 10, totalSeconds: 30)
    XCTAssertEqual(warning.tint, DankColor.Semantic.warning)

    let danger = CountdownRingView(secondsRemaining: 3, totalSeconds: 30)
    XCTAssertEqual(danger.tint, DankColor.Semantic.danger)
  }

  func test_countdownRing_rendersEveryStateRange() {
    for seconds in stride(from: 30.0, through: 0.0, by: -2.5) {
      XCTAssertNotNil(
        CountdownRingView(secondsRemaining: seconds, totalSeconds: 30).body,
        "failed to render at \(seconds)s"
      )
    }
  }

  // MARK: - OfferCardView

  func test_offerCardView_formatPriceMatchesUSD() {
    XCTAssertEqual(OfferCardView.formatPrice(0), "$0.00")
    XCTAssertEqual(OfferCardView.formatPrice(99), "$0.99")
    XCTAssertEqual(OfferCardView.formatPrice(1450), "$14.50")
    XCTAssertEqual(OfferCardView.formatPrice(123_456), "$1,234.56")
  }

  func test_offerCardView_formatDistanceClampsToOneFractional() {
    XCTAssertEqual(OfferCardView.formatDistance(Decimal(string: "3.2")!), "3.2 mi")
    XCTAssertEqual(OfferCardView.formatDistance(Decimal(string: "3.16")!), "3.2 mi")
    XCTAssertEqual(OfferCardView.formatDistance(Decimal(0)), "0.0 mi")
    XCTAssertEqual(OfferCardView.formatDistance(Decimal(string: "12.34")!), "12.3 mi")
  }

  func test_offerCardView_rendersWithAndWithoutSubmittingState() {
    let offer = Self.dispatchOffer()
    XCTAssertNotNil(
      OfferCardView(
        offer: offer,
        pickupSummary: "Bloom · 401 N 3rd St",
        dropoffSummary: "1234 Hennepin Ave",
        secondsRemaining: 18,
        isSubmitting: false,
        onAccept: {},
        onDecline: {}
      ).body
    )
    XCTAssertNotNil(
      OfferCardView(
        offer: offer,
        pickupSummary: "Bloom · 401 N 3rd St",
        dropoffSummary: "1234 Hennepin Ave",
        secondsRemaining: 4,
        isSubmitting: true,
        onAccept: {},
        onDecline: {}
      ).body
    )
  }

  // MARK: - PickupCardView

  func test_pickupCardView_formatDistanceMatchesOffer() {
    XCTAssertEqual(PickupCardView.formatDistance(Decimal(string: "2.4")!), "2.4 mi")
    XCTAssertEqual(PickupCardView.formatDistance(Decimal(0)), "0.0 mi")
  }

  func test_pickupCardView_rendersWithAndWithoutMetrics() {
    let dispensary = Self.dispensary()
    XCTAssertNotNil(
      PickupCardView(
        dispensary: dispensary,
        etaMinutes: 6,
        distanceMiles: Decimal(string: "2.4")!,
        isConfirming: false,
        onConfirm: {}
      ).body
    )
    XCTAssertNotNil(
      PickupCardView(
        dispensary: dispensary,
        etaMinutes: nil,
        distanceMiles: nil,
        isConfirming: true,
        onConfirm: {}
      ).body
    )
  }

  // MARK: - DropoffCardView

  func test_dropoffCardView_rendersAcrossInstructionStates() {
    let customer = Self.customer()
    let withInstructions = DriverHandoffAddress(
      line1: "1234 Hennepin Ave",
      line2: "Apt 4B",
      city: "Minneapolis",
      region: "MN",
      postalCode: "55403",
      location: Coordinate(latitude: 44.974, longitude: -93.275),
      instructions: "Ring buzzer #4B"
    )
    let withoutInstructions = DriverHandoffAddress(
      line1: "1234 Hennepin Ave",
      line2: nil,
      city: "Minneapolis",
      region: "MN",
      postalCode: "55403",
      location: Coordinate(latitude: 44.974, longitude: -93.275),
      instructions: nil
    )
    XCTAssertNotNil(
      DropoffCardView(
        customer: customer,
        address: withInstructions,
        etaMinutes: 4,
        distanceMiles: Decimal(string: "1.6")!,
        isArriving: false,
        onArrived: {}
      ).body
    )
    XCTAssertNotNil(
      DropoffCardView(
        customer: customer,
        address: withoutInstructions,
        etaMinutes: nil,
        distanceMiles: nil,
        isArriving: true,
        onArrived: {}
      ).body
    )
  }

  func test_dropoffCardView_formatDistanceMatchesOffer() {
    XCTAssertEqual(DropoffCardView.formatDistance(Decimal(string: "1.6")!), "1.6 mi")
  }

  // MARK: - IDScanLaunchView

  func test_idScanLaunch_titleForEveryStatus() {
    XCTAssertEqual(IDScanLaunchView.title(for: .notStarted), "Verify the customer's ID")
    XCTAssertEqual(IDScanLaunchView.title(for: .sessionRequested), "Verifying ID…")
    XCTAssertEqual(IDScanLaunchView.title(for: .sdkInProgress), "Verifying ID…")
    XCTAssertEqual(IDScanLaunchView.title(for: .awaitingResult), "Verifying ID…")
    XCTAssertEqual(IDScanLaunchView.title(for: .passed), "ID verified")
    XCTAssertEqual(IDScanLaunchView.title(for: .failed(reason: "blur")), "Couldn't verify")
  }

  func test_idScanLaunch_explainerIncludesAttemptCount() {
    let oneLeft = IDScanLaunchView.explainerCopy(
      for: .failed(reason: "Blurry photo"),
      attemptsRemaining: 1
    )
    XCTAssertEqual(oneLeft, "Blurry photo. 1 attempt remaining.")

    let twoLeft = IDScanLaunchView.explainerCopy(
      for: .failed(reason: "Blurry photo"),
      attemptsRemaining: 2
    )
    XCTAssertEqual(twoLeft, "Blurry photo. 2 attempts remaining.")

    let none = IDScanLaunchView.explainerCopy(
      for: .failed(reason: "Blurry photo"),
      attemptsRemaining: 0
    )
    XCTAssertEqual(none, "Blurry photo. No more attempts — please choose what to do next.")
  }

  func test_idScanLaunch_explainerForNonFailureStatuses() {
    XCTAssertTrue(
      IDScanLaunchView.explainerCopy(for: .notStarted, attemptsRemaining: 3)
        .contains("Minnesota law")
    )
    XCTAssertEqual(
      IDScanLaunchView.explainerCopy(for: .sessionRequested, attemptsRemaining: 3),
      "Starting verification…"
    )
    XCTAssertEqual(
      IDScanLaunchView.explainerCopy(for: .sdkInProgress, attemptsRemaining: 3),
      "Customer is completing the scan."
    )
    XCTAssertEqual(
      IDScanLaunchView.explainerCopy(for: .awaitingResult, attemptsRemaining: 3),
      "Waiting for verification result. This usually takes a few seconds."
    )
    XCTAssertEqual(
      IDScanLaunchView.explainerCopy(for: .passed, attemptsRemaining: 0),
      "You can complete the delivery."
    )
  }

  func test_idScanLaunch_rendersAllStatusVariants() {
    let states: [IDScanStatus] = [
      .notStarted,
      .sessionRequested,
      .sdkInProgress,
      .awaitingResult,
      .passed,
      .failed(reason: "Blur"),
    ]
    for state in states {
      XCTAssertNotNil(
        IDScanLaunchView(
          status: state,
          attemptsRemaining: 2,
          onBeginScan: {},
          onRetry: {},
          onContactSupport: {},
          onReturnToDispensary: {}
        ).body,
        "failed to render \(state)"
      )
    }
  }

  func test_idScanLaunch_rendersTerminalFailureCTAs() {
    // No attempts remaining → escalation triplet
    XCTAssertNotNil(
      IDScanLaunchView(
        status: .failed(reason: "Document mismatch"),
        attemptsRemaining: 0,
        onBeginScan: {},
        onRetry: {},
        onContactSupport: {},
        onReturnToDispensary: {}
      ).body
    )
  }

  // MARK: - DeliveryCompleteView

  func test_deliveryCompleteView_titleBuckets() {
    XCTAssertEqual(
      DeliveryCompleteView.title(isConfirming: true, isCompleted: false, hasError: false),
      "Confirming delivery…"
    )
    XCTAssertEqual(
      DeliveryCompleteView.title(isConfirming: false, isCompleted: true, hasError: false),
      "Delivered"
    )
    XCTAssertEqual(
      DeliveryCompleteView.title(isConfirming: false, isCompleted: false, hasError: true),
      "Couldn't confirm delivery"
    )
    XCTAssertEqual(
      DeliveryCompleteView.title(isConfirming: false, isCompleted: false, hasError: false),
      "Mark as delivered"
    )
  }

  func test_deliveryCompleteView_formatPriceMatchesOffer() {
    XCTAssertEqual(DeliveryCompleteView.formatPrice(1450), "$14.50")
    XCTAssertEqual(DeliveryCompleteView.formatPrice(0), "$0.00")
  }

  func test_deliveryCompleteView_rendersAcrossStates() {
    XCTAssertNotNil(
      DeliveryCompleteView(
        customerDisplayName: "Sam J.",
        payoutEstimateCents: 1450,
        isConfirming: true,
        isCompleted: false,
        errorBanner: nil,
        onBackToShift: {},
        onRetry: {}
      ).body
    )
    XCTAssertNotNil(
      DeliveryCompleteView(
        customerDisplayName: "Sam J.",
        payoutEstimateCents: 1450,
        isConfirming: false,
        isCompleted: true,
        errorBanner: nil,
        onBackToShift: {},
        onRetry: {}
      ).body
    )
    XCTAssertNotNil(
      DeliveryCompleteView(
        customerDisplayName: "Sam J.",
        payoutEstimateCents: nil,
        isConfirming: false,
        isCompleted: false,
        errorBanner: "Couldn't reach server",
        onBackToShift: {},
        onRetry: {}
      ).body
    )
  }

  // MARK: - EarningsWalletView

  func test_earningsWalletView_periodLabels() {
    XCTAssertEqual(EarningsWalletView.label(for: .today), "Today")
    XCTAssertEqual(EarningsWalletView.label(for: .week), "Week")
    XCTAssertEqual(EarningsWalletView.label(for: .month), "Month")
  }

  func test_earningsWalletView_deliveriesLabelPluralizes() {
    XCTAssertEqual(EarningsWalletView.deliveriesLabel(deliveries: 0), "0 deliveries")
    XCTAssertEqual(EarningsWalletView.deliveriesLabel(deliveries: 1), "1 delivery")
    XCTAssertEqual(EarningsWalletView.deliveriesLabel(deliveries: 7), "7 deliveries")
  }

  func test_earningsWalletView_formatPriceMatchesOffer() {
    XCTAssertEqual(EarningsWalletView.formatPrice(14_350), "$143.50")
    XCTAssertEqual(EarningsWalletView.formatPrice(0), "$0.00")
  }

  func test_earningsWalletView_cashoutStatusTintBuckets() {
    XCTAssertEqual(EarningsWalletView.tint(for: .pending), DankColor.Semantic.info)
    XCTAssertEqual(EarningsWalletView.tint(for: .processing), DankColor.Semantic.info)
    XCTAssertEqual(EarningsWalletView.tint(for: .completed), DankColor.Semantic.success)
    XCTAssertEqual(EarningsWalletView.tint(for: .failed), DankColor.Semantic.danger)
    XCTAssertEqual(EarningsWalletView.tint(for: .canceled), DankColor.Text.muted)
  }

  func test_earningsWalletView_rendersAcrossStates() {
    XCTAssertNotNil(
      EarningsWalletView(
        period: .today,
        earnings: Self.earnings(),
        recentCashouts: [Self.cashout()],
        isLoading: false,
        cashoutCTAEnabled: true,
        onPeriodChanged: { _ in },
        onCashoutTapped: {}
      ).body
    )
    XCTAssertNotNil(
      EarningsWalletView(
        period: .week,
        earnings: nil,
        recentCashouts: [],
        isLoading: true,
        cashoutCTAEnabled: false,
        onPeriodChanged: { _ in },
        onCashoutTapped: {}
      ).body
    )
  }

  // MARK: - CashoutSheetView

  func test_cashoutSheetView_formatPriceMatchesOffer() {
    XCTAssertEqual(CashoutSheetView.formatPrice(14_350), "$143.50")
    XCTAssertEqual(CashoutSheetView.formatPrice(0), "$0.00")
  }

  func test_cashoutSheetView_rendersAcrossStates() {
    @State var amount = "25.00"
    XCTAssertNotNil(
      CashoutSheetView(
        amountText: Binding.constant("25.00"),
        availableBalanceCents: 14_350,
        isSubmitting: false,
        errorMessage: nil,
        isConfirmEnabled: true,
        onConfirm: {},
        onCancel: {}
      ).body
    )
    XCTAssertNotNil(
      CashoutSheetView(
        amountText: Binding.constant(""),
        availableBalanceCents: nil,
        isSubmitting: true,
        errorMessage: "Not enough available. You have $15.00 to cash out.",
        isConfirmEnabled: false,
        onConfirm: {},
        onCancel: {}
      ).body
    )
  }

  // MARK: - Fixtures

  private static func dispatchOffer() -> DispatchOffer {
    DispatchOffer(
      id: UUID(uuidString: "00000000-0000-0000-0000-0000000000a1")!,
      orderId: UUID(uuidString: "00000000-0000-0000-0000-0000000000a2")!,
      driverId: UUID(uuidString: "00000000-0000-0000-0000-0000000000a3")!,
      offeredAt: Date(timeIntervalSince1970: 1_700_000_000),
      expiresAt: Date(timeIntervalSince1970: 1_700_000_030),
      payoutEstimateCents: 1450,
      distanceMiles: Decimal(string: "3.2")!,
      status: .offered,
      respondedAt: nil,
      declineReason: nil
    )
  }

  private static func dispensary() -> DriverHandoffDispensary {
    DriverHandoffDispensary(
      id: UUID(uuidString: "00000000-0000-0000-0000-0000000000d3")!,
      name: "Bloom Cannabis Co.",
      addressLine1: "401 N 3rd St",
      addressLine2: nil,
      city: "Minneapolis",
      region: "MN",
      postalCode: "55401",
      location: Coordinate(latitude: 44.985, longitude: -93.270),
      phone: "612-555-0001"
    )
  }

  private static func customer() -> DriverHandoffCustomer {
    DriverHandoffCustomer(
      firstName: "Sam",
      lastName: "Johnson",
      maskedPhone: "***-***-1234"
    )
  }

  private static func earnings() -> DriverEarnings {
    DriverEarnings(
      period: .today,
      since: Date(timeIntervalSince1970: 1_699_956_000),
      until: Date(timeIntervalSince1970: 1_700_042_400),
      tipsCents: 4_850,
      deliveryFeesCents: 9_500,
      deliveriesCount: 7,
      totalCents: 14_350
    )
  }

  private static func cashout() -> CashoutRequest {
    CashoutRequest(
      id: UUID(uuidString: "00000000-0000-0000-0000-0000000000c1")!,
      amountCents: 5_000,
      status: .completed,
      requestedAt: Date(timeIntervalSince1970: 1_700_000_000),
      aeropayPayoutRef: "AP-123"
    )
  }
}
