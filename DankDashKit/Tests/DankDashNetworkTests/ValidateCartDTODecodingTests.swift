import XCTest
import DankDashDomain
@testable import DankDashNetwork

final class ValidateCartDTODecodingTests: XCTestCase {
  private let decoder = JSONDecoder()

  func test_validateResponse_decodesPassingEvaluation() throws {
    let dto = try decoder.decode(
      ValidateCartResponseDTO.self,
      from: Self.passingJSON.data(using: .utf8)!
    )
    let domain = try XCTUnwrap(dto.toDomain())

    XCTAssertTrue(domain.passed)
    XCTAssertEqual(domain.rules.count, 3)
    XCTAssertTrue(domain.rules.allSatisfy(\.passed))
    XCTAssertEqual(domain.cartTotals.flowerGrams, Decimal(string: "14.0"))
    XCTAssertEqual(domain.cartTotals.concentrateGrams, Decimal(string: "0"))
    XCTAssertEqual(domain.cartTotals.edibleThcMg, Decimal(string: "100.0"))
    XCTAssertEqual(domain.limits.flowerGramsMax, Decimal(string: "56.7"))
    XCTAssertEqual(domain.limits.concentrateGramsMax, Decimal(string: "8.0"))
    XCTAssertEqual(domain.limits.edibleThcMgMax, Decimal(string: "800.0"))
    XCTAssertEqual(domain.evaluationVersion, "v1")
  }

  func test_validateResponse_decodesFailingEvaluationWithDetails() throws {
    let dto = try decoder.decode(
      ValidateCartResponseDTO.self,
      from: Self.failingFlowerJSON.data(using: .utf8)!
    )
    let domain = try XCTUnwrap(dto.toDomain())

    XCTAssertFalse(domain.passed)
    let flowerRule = try XCTUnwrap(domain.rules.first { $0.rule == .perTransactionLimit })
    XCTAssertFalse(flowerRule.passed)
    let details = try XCTUnwrap(flowerRule.details.object)
    guard case let .double(over) = details["flowerGramsOver"] else {
      return XCTFail("expected .double for flowerGramsOver, got \(String(describing: details["flowerGramsOver"]))")
    }
    XCTAssertEqual(over, 1.3, accuracy: 0.0001)
  }

  func test_validateResponse_silentlyDropsUnknownRules() throws {
    let json = Self.passingJSON.replacingOccurrences(
      of: "\"rule\": \"hours\"",
      with: "\"rule\": \"future_rule_from_server\""
    )
    let dto = try decoder.decode(ValidateCartResponseDTO.self, from: json.data(using: .utf8)!)
    let domain = try XCTUnwrap(dto.toDomain())
    XCTAssertEqual(
      domain.rules.count,
      2,
      "unknown rules must drop silently so an older client renders the rules it understands and trusts the server's `passed` verdict"
    )
  }

  func test_validateResponse_returnsNilIfEvaluatedAtMalformed() throws {
    let json = Self.passingJSON.replacingOccurrences(
      of: "\"evaluatedAt\": \"2026-05-20T13:10:00.000Z\"",
      with: "\"evaluatedAt\": \"not-a-timestamp\""
    )
    let dto = try decoder.decode(ValidateCartResponseDTO.self, from: json.data(using: .utf8)!)
    XCTAssertNil(dto.toDomain())
  }

  func test_decimalConversion_preservesBaseTenPrecision_for_56_7() {
    // The MN flower per-transaction limit (Minn. Stat. § 342.27) is exactly
    // 56.7g. JSON 56.7 -> Double 56.7 -> Decimal(double) would yield
    // 56.6999999... — the wire helper round-trips via Double's shortest
    // decimal representation so this lands exact.
    let result = ValidateCartWire.decimal(from: 56.7)
    XCTAssertEqual(result, Decimal(string: "56.7"))
  }

  func test_decimalConversion_preservesEdibleTHCBoundary_for_800() {
    let result = ValidateCartWire.decimal(from: 800.0)
    XCTAssertEqual(result, Decimal(string: "800"))
  }

  // MARK: - Fixtures

  private static let passingJSON = """
  {
    "passed": true,
    "rules": [
      { "rule": "per_transaction_limit", "passed": true, "details": {} },
      { "rule": "hours", "passed": true, "details": {} },
      { "rule": "delivery_geofence", "passed": true, "details": {} }
    ],
    "cartTotals": {
      "flowerGrams": 14.0,
      "concentrateGrams": 0,
      "edibleThcMg": 100.0
    },
    "limits": {
      "flowerGramsMax": 56.7,
      "concentrateGramsMax": 8.0,
      "edibleThcMgMax": 800.0
    },
    "evaluatedAt": "2026-05-20T13:10:00.000Z",
    "evaluationVersion": "v1"
  }
  """

  private static let failingFlowerJSON = """
  {
    "passed": false,
    "rules": [
      {
        "rule": "per_transaction_limit",
        "passed": false,
        "details": { "flowerGramsOver": 1.3 }
      },
      { "rule": "hours", "passed": true, "details": {} },
      { "rule": "delivery_geofence", "passed": true, "details": {} }
    ],
    "cartTotals": {
      "flowerGrams": 58.0,
      "concentrateGrams": 0,
      "edibleThcMg": 0
    },
    "limits": {
      "flowerGramsMax": 56.7,
      "concentrateGramsMax": 8.0,
      "edibleThcMgMax": 800.0
    },
    "evaluatedAt": "2026-05-20T13:10:00.000Z",
    "evaluationVersion": "v1"
  }
  """
}
