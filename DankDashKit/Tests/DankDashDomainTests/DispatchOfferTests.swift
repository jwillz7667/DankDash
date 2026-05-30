import XCTest
@testable import DankDashDomain

/// ``DispatchOffer`` is Phase 20–facing but its expiry math runs in
/// Phase 19's realtime decoder as soon as the `/driver` namespace
/// lights up. The offer-card timer relies on `secondsRemaining` not
/// going negative.
final class DispatchOfferTests: XCTestCase {
  private func makeOffer(
    offeredAt: Date,
    expiresAt: Date,
    status: DispatchOffer.Status = .offered
  ) -> DispatchOffer {
    DispatchOffer(
      id: UUID(),
      orderId: UUID(),
      driverId: UUID(),
      offeredAt: offeredAt,
      expiresAt: expiresAt,
      payoutEstimateCents: 1500,
      distanceMiles: Decimal(string: "1.234") ?? 0,
      status: status,
      respondedAt: nil,
      declineReason: nil
    )
  }

  func test_isExpired_falseBeforeExpiry() {
    let now = Date(timeIntervalSince1970: 1_000_000)
    let offer = makeOffer(offeredAt: now, expiresAt: now.addingTimeInterval(30))
    XCTAssertFalse(offer.isExpired(referenceDate: now))
  }

  func test_isExpired_trueAtExpiry() {
    let now = Date(timeIntervalSince1970: 1_000_000)
    let offer = makeOffer(offeredAt: now, expiresAt: now)
    XCTAssertTrue(offer.isExpired(referenceDate: now))
  }

  func test_isExpired_trueAfterExpiry() {
    let now = Date(timeIntervalSince1970: 1_000_000)
    let offer = makeOffer(offeredAt: now, expiresAt: now.addingTimeInterval(-1))
    XCTAssertTrue(offer.isExpired(referenceDate: now))
  }

  func test_secondsRemaining_returnsPositiveBeforeExpiry() {
    let now = Date(timeIntervalSince1970: 1_000_000)
    let offer = makeOffer(offeredAt: now, expiresAt: now.addingTimeInterval(30))
    XCTAssertEqual(offer.secondsRemaining(referenceDate: now), 30, accuracy: 0.001)
  }

  func test_secondsRemaining_clampsToZeroPastExpiry() {
    let now = Date(timeIntervalSince1970: 1_000_000)
    let offer = makeOffer(offeredAt: now, expiresAt: now.addingTimeInterval(-10))
    XCTAssertEqual(offer.secondsRemaining(referenceDate: now), 0)
  }

  func test_statusRawValuesMatchWire() {
    XCTAssertEqual(DispatchOffer.Status.offered.rawValue, "offered")
    XCTAssertEqual(DispatchOffer.Status.accepted.rawValue, "accepted")
    XCTAssertEqual(DispatchOffer.Status.declined.rawValue, "declined")
    XCTAssertEqual(DispatchOffer.Status.expired.rawValue, "expired")
  }
}
