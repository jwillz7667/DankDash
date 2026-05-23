import XCTest
@testable import DankDashDomain

/// Wire-format guard for `RuleId`. The raw values are the contract with
/// `@dankdash/compliance` — a quiet rename would silently break
/// validate-response decoding, so every case is asserted explicitly
/// against the on-the-wire string and the `allCases` count is checked
/// so a future addition can't be forgotten.
final class RuleIdTests: XCTestCase {
  func test_rawValuesMatchWire() {
    XCTAssertEqual(RuleId.age.rawValue, "age")
    XCTAssertEqual(RuleId.kyc.rawValue, "kyc")
    XCTAssertEqual(RuleId.dispensaryLicense.rawValue, "dispensary_license")
    XCTAssertEqual(RuleId.hours.rawValue, "hours")
    XCTAssertEqual(RuleId.deliveryGeofence.rawValue, "delivery_geofence")
    XCTAssertEqual(RuleId.perTransactionLimit.rawValue, "per_transaction_limit")
    XCTAssertEqual(RuleId.productProvenance.rawValue, "product_provenance")
    XCTAssertEqual(RuleId.evaluation.rawValue, "evaluation")
  }

  func test_allCasesCountStable() {
    XCTAssertEqual(RuleId.allCases.count, 8)
  }

  func test_codableRoundTripPreservesRawValue() throws {
    for rule in RuleId.allCases {
      let data = try JSONEncoder().encode(rule)
      let decoded = try JSONDecoder().decode(RuleId.self, from: data)
      XCTAssertEqual(decoded, rule)
    }
  }
}
