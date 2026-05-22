import XCTest
import Foundation
import SwiftUI
import DankDashDomain
@testable import DankDashDesignSystem

/// Smoke tests for the Phase 19 driver-facing DesignSystem components.
/// Same intent as the Phase 18 suite: catch initializer-signature
/// regressions, exercise every public variant, and pin the pure helper
/// outputs (gradient mixing, dot status, tone mapping) that the
/// reducers' UX depends on.
@MainActor
final class DriverComponentSmokeTests: XCTestCase {

  // MARK: - ShiftToggle

  func test_shiftToggle_titleForEveryMode() {
    XCTAssertEqual(ShiftToggle.title(for: .offline), "GO ONLINE")
    XCTAssertEqual(ShiftToggle.title(for: .online), "GO OFFLINE")
    XCTAssertEqual(ShiftToggle.title(for: .transitioning), "Working…")
    XCTAssertEqual(ShiftToggle.title(for: .lockedDuringDelivery), "ON DELIVERY")
  }

  func test_shiftToggle_isInteractiveOnlyForRestingModes() {
    XCTAssertTrue(ShiftToggle.isInteractive(mode: .offline))
    XCTAssertTrue(ShiftToggle.isInteractive(mode: .online))
    XCTAssertFalse(ShiftToggle.isInteractive(mode: .transitioning))
    XCTAssertFalse(ShiftToggle.isInteractive(mode: .lockedDuringDelivery))
  }

  func test_shiftToggle_rendersEveryMode() {
    XCTAssertNotNil(ShiftToggle(mode: .offline, onToggle: {}).body)
    XCTAssertNotNil(ShiftToggle(mode: .online, onToggle: {}).body)
    XCTAssertNotNil(ShiftToggle(mode: .transitioning, onToggle: {}).body)
    XCTAssertNotNil(ShiftToggle(mode: .lockedDuringDelivery, onToggle: {}).body)
  }

  // MARK: - EarningsSummaryCard

  func test_earningsSummaryCard_formatPriceMatchesUSD() {
    XCTAssertEqual(EarningsSummaryCard.formatPrice(0), "$0.00")
    XCTAssertEqual(EarningsSummaryCard.formatPrice(99), "$0.99")
    XCTAssertEqual(EarningsSummaryCard.formatPrice(14_350), "$143.50")
    XCTAssertEqual(EarningsSummaryCard.formatPrice(1_234_567), "$12,345.67")
  }

  func test_earningsSummaryCard_periodLabels() {
    XCTAssertEqual(EarningsSummaryCard.label(for: .today), "Today")
    XCTAssertEqual(EarningsSummaryCard.label(for: .week), "This week")
    XCTAssertEqual(EarningsSummaryCard.label(for: .month), "This month")
  }

  func test_earningsSummaryCard_secondaryLabelPluralization() {
    let one = EarningsSummaryCard(
      earnings: Self.earnings(deliveriesCount: 1, tipsCents: 500, totalCents: 1500),
      onTap: {}
    )
    XCTAssertEqual(one.secondaryLabel, "1 delivery · $5.00 tips")

    let many = EarningsSummaryCard(
      earnings: Self.earnings(deliveriesCount: 7, tipsCents: 1850, totalCents: 14_350),
      onTap: {}
    )
    XCTAssertEqual(many.secondaryLabel, "7 deliveries · $18.50 tips")

    let none = EarningsSummaryCard(earnings: nil, onTap: {})
    XCTAssertEqual(none.secondaryLabel, "0 deliveries · $0.00 tips")
  }

  func test_earningsSummaryCard_rendersWithAndWithoutEarnings() {
    let withEarnings = EarningsSummaryCard(
      earnings: Self.earnings(deliveriesCount: 7, tipsCents: 1850, totalCents: 14_350),
      onTap: {}
    )
    XCTAssertNotNil(withEarnings.body)
    XCTAssertEqual(withEarnings.totalLabel, "$143.50")

    let empty = EarningsSummaryCard(earnings: nil, onTap: {})
    XCTAssertNotNil(empty.body)
    XCTAssertEqual(empty.totalLabel, "$0.00")
  }

  // MARK: - DocumentUploadRow

  func test_documentUploadRow_iconAndCopyForEverySlot() {
    let license = DocumentUploadRow(slot: .driversLicense, state: .empty, onTap: {})
    XCTAssertEqual(license.iconName, "person.text.rectangle")
    XCTAssertEqual(license.secondaryLabel, DocumentSlot.driversLicense.helperText)

    let insurance = DocumentUploadRow(slot: .vehicleInsurance, state: .uploaded, onTap: {})
    XCTAssertEqual(insurance.iconName, "doc.text.fill")
    XCTAssertEqual(insurance.secondaryLabel, DocumentSlot.vehicleInsurance.helperText)

    let registration = DocumentUploadRow(slot: .vehicleRegistration, state: .uploading, onTap: {})
    XCTAssertEqual(registration.iconName, "car.fill")
  }

  func test_documentUploadRow_failedStateShowsReasonInSecondaryLabel() {
    let row = DocumentUploadRow(
      slot: .driversLicense,
      state: .failed(reason: "File too large"),
      onTap: {}
    )
    XCTAssertEqual(row.secondaryLabel, "File too large")
  }

  func test_documentUploadRow_accessibilityLabelCapturesState() {
    let empty = DocumentUploadRow(slot: .driversLicense, state: .empty, onTap: {})
    XCTAssertEqual(empty.accessibilityLabel, "Driver's license, not uploaded")

    let uploaded = DocumentUploadRow(slot: .vehicleInsurance, state: .uploaded, onTap: {})
    XCTAssertEqual(uploaded.accessibilityLabel, "Vehicle insurance, uploaded")

    let failed = DocumentUploadRow(
      slot: .vehicleRegistration,
      state: .failed(reason: "Network error"),
      onTap: {}
    )
    XCTAssertEqual(failed.accessibilityLabel, "Vehicle registration, upload failed: Network error")
  }

  func test_documentUploadRow_rendersEveryStateAndSlot() {
    let states: [DocumentUploadRow.State] = [
      .empty,
      .uploading,
      .uploaded,
      .failed(reason: "Generic failure"),
    ]
    for slot in DocumentSlot.allCases {
      for state in states {
        XCTAssertNotNil(DocumentUploadRow(slot: slot, state: state, onTap: {}).body)
      }
    }
  }

  // MARK: - OnboardingStepIndicator

  func test_onboardingStepIndicator_statusBuckets() {
    XCTAssertEqual(
      OnboardingStepIndicator.status(currentStep: 1, totalSteps: 4, index: 0),
      .completed
    )
    XCTAssertEqual(
      OnboardingStepIndicator.status(currentStep: 1, totalSteps: 4, index: 1),
      .current
    )
    XCTAssertEqual(
      OnboardingStepIndicator.status(currentStep: 1, totalSteps: 4, index: 2),
      .upcoming
    )
    XCTAssertEqual(
      OnboardingStepIndicator.status(currentStep: 1, totalSteps: 4, index: 3),
      .upcoming
    )
  }

  func test_onboardingStepIndicator_clampsOutOfRangeCurrent() {
    let underflow = OnboardingStepIndicator(currentStep: -3, totalSteps: 4)
    XCTAssertEqual(underflow.clampedCurrent, 0)

    let overflow = OnboardingStepIndicator(currentStep: 10, totalSteps: 4)
    XCTAssertEqual(overflow.clampedCurrent, 3)

    let inRange = OnboardingStepIndicator(currentStep: 2, totalSteps: 4)
    XCTAssertEqual(inRange.clampedCurrent, 2)
  }

  func test_onboardingStepIndicator_rendersStepCounts() {
    XCTAssertNotNil(OnboardingStepIndicator(currentStep: 0, totalSteps: 4).body)
    XCTAssertNotNil(OnboardingStepIndicator(currentStep: 3, totalSteps: 4).body)
    XCTAssertNotNil(OnboardingStepIndicator(currentStep: 0, totalSteps: 1).body)
  }

  // MARK: - BackgroundCheckStatusBadge

  func test_backgroundCheckStatusBadge_toneMapping() {
    XCTAssertEqual(BackgroundCheckStatusBadge.tone(for: .notStarted), .neutral)
    XCTAssertEqual(BackgroundCheckStatusBadge.tone(for: .inReview), .warning)
    XCTAssertEqual(BackgroundCheckStatusBadge.tone(for: .passed), .success)
  }

  func test_backgroundCheckStatusBadge_rendersEveryCase() {
    for status in BackgroundCheckStatus.allCases {
      XCTAssertNotNil(BackgroundCheckStatusBadge(status: status).body)
    }
  }

  // MARK: - DriverStatusPill

  func test_driverStatusPill_toneBuckets() {
    XCTAssertEqual(DriverStatusPill.tone(for: .online), .success)
    XCTAssertEqual(DriverStatusPill.tone(for: .offline), .neutral)
    XCTAssertEqual(DriverStatusPill.tone(for: .enRoutePickup), .info)
    XCTAssertEqual(DriverStatusPill.tone(for: .enRouteDropoff), .info)
    XCTAssertEqual(DriverStatusPill.tone(for: .onBreak), .warning)
    XCTAssertEqual(DriverStatusPill.tone(for: .unavailable), .danger)
  }

  func test_driverStatusPill_rendersEveryStatus() {
    for status in DriverStatus.allCases {
      let pill = DriverStatusPill(status: status)
      XCTAssertNotNil(pill.body)
      XCTAssertEqual(pill.label, status.displayLabel)
    }
  }

  // MARK: - DemandHeatmapMapView

  func test_demandHeatmapMapView_fillColorIsStableAtAnchors() {
    let low = DemandHeatmapMapView.fillColor(for: Decimal(0))
    let mid = DemandHeatmapMapView.fillColor(for: Decimal(string: "0.5")!)
    let high = DemandHeatmapMapView.fillColor(for: Decimal(1))
    // Same input → same output (Color equatable by representation).
    XCTAssertEqual(low, DemandHeatmapMapView.fillColor(for: Decimal(0)))
    XCTAssertEqual(mid, DemandHeatmapMapView.fillColor(for: Decimal(string: "0.5")!))
    XCTAssertEqual(high, DemandHeatmapMapView.fillColor(for: Decimal(1)))
    XCTAssertNotEqual(low, high)
  }

  func test_demandHeatmapMapView_fillColorClampsOutOfRange() {
    let belowZero = DemandHeatmapMapView.fillColor(for: Decimal(-1))
    let aboveOne = DemandHeatmapMapView.fillColor(for: Decimal(2))
    let zero = DemandHeatmapMapView.fillColor(for: Decimal(0))
    let one = DemandHeatmapMapView.fillColor(for: Decimal(1))
    XCTAssertEqual(belowZero, zero)
    XCTAssertEqual(aboveOne, one)
  }

  func test_demandHeatmapMapView_rendersWithAndWithoutCellsAndDriver() {
    let cells = [Self.heatmapCell(score: "0.8"), Self.heatmapCell(score: "0.3")]
    let driver = Coordinate(latitude: 44.9778, longitude: -93.2650)

    XCTAssertNotNil(
      DemandHeatmapMapView(cells: cells, driverCoordinate: driver).body
    )
    XCTAssertNotNil(
      DemandHeatmapMapView(cells: cells, driverCoordinate: nil).body
    )
    XCTAssertNotNil(
      DemandHeatmapMapView(cells: [], driverCoordinate: driver).body
    )
    XCTAssertNotNil(
      DemandHeatmapMapView(cells: [], driverCoordinate: nil).body
    )
  }

  // MARK: - DriverMapHomeView

  func test_driverMapHomeView_rendersAcrossToggleModes() {
    let earnings = Self.earnings(deliveriesCount: 3, tipsCents: 1200, totalCents: 5800)
    let driver = Coordinate(latitude: 44.9778, longitude: -93.2650)
    let cells = [Self.heatmapCell(score: "0.6")]

    for mode in [
      ShiftToggle.Mode.offline,
      .online,
      .transitioning,
      .lockedDuringDelivery,
    ] {
      let view = DriverMapHomeView(
        toggleMode: mode,
        cells: cells,
        driverCoordinate: driver,
        earnings: earnings,
        onToggleShift: {},
        onEarningsTapped: {}
      )
      XCTAssertNotNil(view.body, "failed to render for \(mode)")
    }
  }

  func test_driverMapHomeView_rendersWithoutOptionalState() {
    let view = DriverMapHomeView(
      toggleMode: .offline,
      cells: [],
      driverCoordinate: nil,
      earnings: nil,
      onToggleShift: {},
      onEarningsTapped: {}
    )
    XCTAssertNotNil(view.body)
  }

  // MARK: - Fixtures

  private static func earnings(
    deliveriesCount: Int,
    tipsCents: Int,
    totalCents: Int
  ) -> DriverEarnings {
    DriverEarnings(
      period: .today,
      since: Date(timeIntervalSince1970: 1_700_000_000),
      until: Date(timeIntervalSince1970: 1_700_086_400),
      tipsCents: tipsCents,
      deliveryFeesCents: totalCents - tipsCents,
      deliveriesCount: deliveriesCount,
      totalCents: totalCents
    )
  }

  private static func heatmapCell(score: String) -> DemandHeatmapCell {
    DemandHeatmapCell(
      cellId: "cell-\(score)",
      polygon: [
        Coordinate(latitude: 44.978, longitude: -93.270),
        Coordinate(latitude: 44.980, longitude: -93.265),
        Coordinate(latitude: 44.978, longitude: -93.260),
        Coordinate(latitude: 44.976, longitude: -93.265),
      ],
      demandScore: Decimal(string: score)!
    )
  }
}
