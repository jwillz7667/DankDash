import XCTest
@testable import DankDashDomain

/// The DB has no dedicated background-check enum column — status is
/// derived from `backgroundCheckPassedAt` + `backgroundCheckProviderRef`.
/// The "pending review" copy in the onboarding flow reads this enum, so
/// the derivation is end-user-visible and worth pinning.
final class BackgroundCheckStatusTests: XCTestCase {
  private func makeDriver(
    backgroundCheckPassedAt: String? = nil,
    backgroundCheckProviderRef: String? = nil
  ) -> Driver {
    Driver(
      id: UUID(),
      userId: UUID(),
      vehicle: Vehicle(),
      insuranceDocKey: nil,
      insuranceExpiresAt: nil,
      backgroundCheckPassedAt: backgroundCheckPassedAt,
      backgroundCheckProviderRef: backgroundCheckProviderRef,
      currentStatus: .offline,
      lastStatusChangeAt: Date(timeIntervalSince1970: 0),
      currentLocation: nil,
      currentLocationUpdatedAt: nil,
      currentOrderId: nil,
      ratingAvg: nil,
      ratingCount: 0,
      totalDeliveries: 0,
      createdAt: Date(timeIntervalSince1970: 0),
      updatedAt: Date(timeIntervalSince1970: 0)
    )
  }

  func test_from_returnsNotStartedWhenNeitherFieldSet() {
    let driver = makeDriver()
    XCTAssertEqual(BackgroundCheckStatus.from(driver: driver), .notStarted)
  }

  func test_from_returnsInReviewWhenOnlyProviderRefSet() {
    let driver = makeDriver(backgroundCheckProviderRef: "veriff_abc123")
    XCTAssertEqual(BackgroundCheckStatus.from(driver: driver), .inReview)
  }

  func test_from_returnsPassedWhenPassedAtSet() {
    let driver = makeDriver(
      backgroundCheckPassedAt: "2026-04-15",
      backgroundCheckProviderRef: nil
    )
    XCTAssertEqual(BackgroundCheckStatus.from(driver: driver), .passed)
  }

  func test_from_returnsPassedWhenBothFieldsSet() {
    // Once a clearance lands, the provider ref is no longer load-bearing —
    // the driver is cleared regardless.
    let driver = makeDriver(
      backgroundCheckPassedAt: "2026-04-15",
      backgroundCheckProviderRef: "veriff_abc123"
    )
    XCTAssertEqual(BackgroundCheckStatus.from(driver: driver), .passed)
  }

  func test_from_treatsEmptyPassedAtAsNotPassed() {
    let driver = makeDriver(backgroundCheckPassedAt: "", backgroundCheckProviderRef: nil)
    XCTAssertEqual(BackgroundCheckStatus.from(driver: driver), .notStarted)
  }

  func test_from_treatsEmptyProviderRefAsNotInReview() {
    let driver = makeDriver(backgroundCheckProviderRef: "")
    XCTAssertEqual(BackgroundCheckStatus.from(driver: driver), .notStarted)
  }

  func test_displayLabelNonEmptyForEveryCase() {
    for status in BackgroundCheckStatus.allCases {
      XCTAssertFalse(status.displayLabel.isEmpty, "\(status) displayLabel empty")
    }
  }
}
