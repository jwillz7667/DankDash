import XCTest
@testable import DankDashDomain

final class DriverShiftTests: XCTestCase {
  private func makeShift(startedAt: Date, endedAt: Date?) -> DriverShift {
    DriverShift(
      id: UUID(),
      driverId: UUID(),
      startedAt: startedAt,
      endedAt: endedAt,
      startingLocation: nil,
      endingLocation: nil,
      totalMiles: nil,
      totalDeliveries: 0,
      totalEarningsCents: 0
    )
  }

  func test_isActive_trueWhenEndedAtNil() {
    XCTAssertTrue(makeShift(startedAt: Date(), endedAt: nil).isActive)
  }

  func test_isActive_falseWhenEndedAtSet() {
    let now = Date()
    XCTAssertFalse(makeShift(startedAt: now, endedAt: now.addingTimeInterval(3600)).isActive)
  }

  func test_duration_closedShiftReturnsFixedWindow() {
    let started = Date(timeIntervalSince1970: 1_000_000)
    let ended = started.addingTimeInterval(7200)  // two hours
    XCTAssertEqual(makeShift(startedAt: started, endedAt: ended).duration(), 7200, accuracy: 0.001)
  }

  func test_duration_activeShiftCountsToReferenceDate() {
    let started = Date(timeIntervalSince1970: 1_000_000)
    let reference = started.addingTimeInterval(1500)
    let shift = makeShift(startedAt: started, endedAt: nil)
    XCTAssertEqual(shift.duration(referenceDate: reference), 1500, accuracy: 0.001)
  }

  func test_duration_clampsToZeroWhenReferenceBeforeStart() {
    // A clock skew between server and device could yield a negative
    // delta — the live timer should clamp to 0 rather than render
    // "−00:42" in the UI.
    let started = Date(timeIntervalSince1970: 2_000_000)
    let reference = Date(timeIntervalSince1970: 1_999_000)
    let shift = makeShift(startedAt: started, endedAt: nil)
    XCTAssertEqual(shift.duration(referenceDate: reference), 0)
  }
}
