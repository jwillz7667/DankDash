import XCTest
@testable import DankDashDomain

/// ``SelfSettableDriverStatus`` is the narrowed enum the server accepts
/// on `POST /v1/driver/status`. The contract:
///
///   - Three cases only (`online`, `on_break`, `unavailable`).
///   - Wire raw values match the full ``DriverStatus`` raw values so the
///     same string survives a round-trip through either decoder.
///   - The projection back to ``DriverStatus`` never loses information.
final class SelfSettableDriverStatusTests: XCTestCase {
  func test_allCasesCountIsThree() {
    XCTAssertEqual(SelfSettableDriverStatus.allCases.count, 3)
  }

  func test_rawValuesMatchDriverStatus() {
    XCTAssertEqual(SelfSettableDriverStatus.online.rawValue, DriverStatus.online.rawValue)
    XCTAssertEqual(SelfSettableDriverStatus.onBreak.rawValue, DriverStatus.onBreak.rawValue)
    XCTAssertEqual(SelfSettableDriverStatus.unavailable.rawValue, DriverStatus.unavailable.rawValue)
  }

  func test_asDriverStatusProjection() {
    XCTAssertEqual(SelfSettableDriverStatus.online.asDriverStatus, .online)
    XCTAssertEqual(SelfSettableDriverStatus.onBreak.asDriverStatus, .onBreak)
    XCTAssertEqual(SelfSettableDriverStatus.unavailable.asDriverStatus, .unavailable)
  }

  func test_displayLabelNonEmptyForEveryCase() {
    for status in SelfSettableDriverStatus.allCases {
      XCTAssertFalse(status.displayLabel.isEmpty, "\(status) displayLabel empty")
    }
  }
}
