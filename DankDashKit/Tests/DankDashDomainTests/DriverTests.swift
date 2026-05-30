import XCTest
@testable import DankDashDomain

final class DriverTests: XCTestCase {
  private func makeDriver(
    backgroundCheckPassedAt: String? = nil,
    backgroundCheckProviderRef: String? = nil,
    currentStatus: DriverStatus = .offline,
    currentOrderId: UUID? = nil,
    ratingAvg: Decimal? = nil,
    ratingCount: Int = 0
  ) -> Driver {
    Driver(
      id: UUID(),
      userId: UUID(),
      vehicle: Vehicle(),
      insuranceDocKey: nil,
      insuranceExpiresAt: nil,
      backgroundCheckPassedAt: backgroundCheckPassedAt,
      backgroundCheckProviderRef: backgroundCheckProviderRef,
      currentStatus: currentStatus,
      lastStatusChangeAt: Date(timeIntervalSince1970: 0),
      currentLocation: nil,
      currentLocationUpdatedAt: nil,
      currentOrderId: currentOrderId,
      ratingAvg: ratingAvg,
      ratingCount: ratingCount,
      totalDeliveries: 0,
      createdAt: Date(timeIntervalSince1970: 0),
      updatedAt: Date(timeIntervalSince1970: 0)
    )
  }

  // MARK: - isBackgroundCheckPassed

  func test_isBackgroundCheckPassed_falseWhenNil() {
    XCTAssertFalse(makeDriver(backgroundCheckPassedAt: nil).isBackgroundCheckPassed)
  }

  func test_isBackgroundCheckPassed_falseWhenEmptyString() {
    XCTAssertFalse(makeDriver(backgroundCheckPassedAt: "").isBackgroundCheckPassed)
  }

  func test_isBackgroundCheckPassed_trueWhenSet() {
    XCTAssertTrue(makeDriver(backgroundCheckPassedAt: "2026-01-15").isBackgroundCheckPassed)
  }

  // MARK: - isOnActiveDelivery

  func test_isOnActiveDelivery_falseWhenOfflineAndNoOrder() {
    XCTAssertFalse(makeDriver(currentStatus: .offline, currentOrderId: nil).isOnActiveDelivery)
  }

  func test_isOnActiveDelivery_trueWhenEnRoutePickup() {
    XCTAssertTrue(makeDriver(currentStatus: .enRoutePickup, currentOrderId: nil).isOnActiveDelivery)
  }

  func test_isOnActiveDelivery_trueWhenEnRouteDropoff() {
    XCTAssertTrue(makeDriver(currentStatus: .enRouteDropoff, currentOrderId: nil).isOnActiveDelivery)
  }

  func test_isOnActiveDelivery_trueWhenCurrentOrderIdSet() {
    // Belt-and-suspenders — covers a stale status row plus a fresh
    // assignment, which the dispatch handler can produce in between
    // status patches.
    XCTAssertTrue(makeDriver(currentStatus: .online, currentOrderId: UUID()).isOnActiveDelivery)
  }

  // MARK: - ratingDisplay

  func test_ratingDisplay_nilWhenNoRatings() {
    XCTAssertNil(makeDriver(ratingAvg: nil, ratingCount: 0).ratingDisplay)
  }

  func test_ratingDisplay_nilWhenAvgPresentButCountZero() {
    XCTAssertNil(makeDriver(ratingAvg: Decimal(string: "4.8"), ratingCount: 0).ratingDisplay)
  }

  func test_ratingDisplay_formatsAvgWithCount() {
    let driver = makeDriver(ratingAvg: Decimal(string: "4.92"), ratingCount: 123)
    XCTAssertEqual(driver.ratingDisplay, "4.9 (123)")
  }

  func test_ratingDisplay_padsWholeNumberWithOneFractionDigit() {
    let driver = makeDriver(ratingAvg: Decimal(integerLiteral: 5), ratingCount: 7)
    XCTAssertEqual(driver.ratingDisplay, "5.0 (7)")
  }
}
