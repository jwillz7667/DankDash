import XCTest
@testable import DankDashDomain

final class DriverEarningsTests: XCTestCase {
  private func makeEarnings(
    deliveriesCount: Int,
    totalCents: Int
  ) -> DriverEarnings {
    DriverEarnings(
      period: .today,
      since: Date(timeIntervalSince1970: 0),
      until: Date(timeIntervalSince1970: 86_400),
      tipsCents: 0,
      deliveryFeesCents: 0,
      deliveriesCount: deliveriesCount,
      totalCents: totalCents
    )
  }

  func test_averagePerDelivery_nilForEmptyWindow() {
    XCTAssertNil(makeEarnings(deliveriesCount: 0, totalCents: 0).averagePerDeliveryCents)
  }

  func test_averagePerDelivery_computesIntegerDivision() {
    // Three deliveries totaling $30.00 ⇒ $10.00 per delivery
    XCTAssertEqual(makeEarnings(deliveriesCount: 3, totalCents: 3000).averagePerDeliveryCents, 1000)
  }

  func test_averagePerDelivery_truncatesFractionalCents() {
    // $10.00 across 3 deliveries ⇒ $3.33 (integer cents truncate)
    XCTAssertEqual(makeEarnings(deliveriesCount: 3, totalCents: 1000).averagePerDeliveryCents, 333)
  }
}
