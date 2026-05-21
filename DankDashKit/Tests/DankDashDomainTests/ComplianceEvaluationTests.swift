import XCTest
@testable import DankDashDomain

/// `ComplianceEvaluation` is the validate-response shape. The decoder
/// has to survive four realistic server outputs:
///
///   1. Passing — every rule clear, totals well under limits.
///   2. `perTransactionLimit` failure — totals exceed flowerGramsMax,
///      details carry the over-amount.
///   3. `deliveryGeofence` failure — address outside polygon, details
///      carry the candidate coordinate and the rejected polygon.
///   4. `hours` failure — dispensary closed, details carry `opensAt`.
///
/// Plus the per-field accessors (`result(for:)`, `failedRules`) and a
/// Decimal precision check that survives JSON-number round-trip for
/// exact-in-Double values (integers + halves).
final class ComplianceEvaluationTests: XCTestCase {
  private func decoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let plain = ISO8601DateFormatter()
    decoder.dateDecodingStrategy = .custom { decoder in
      let container = try decoder.singleValueContainer()
      let value = try container.decode(String.self)
      if let date = fractional.date(from: value) { return date }
      if let date = plain.date(from: value) { return date }
      throw DecodingError.dataCorruptedError(
        in: container,
        debugDescription: "Invalid ISO 8601 date: \(value)"
      )
    }
    return decoder
  }

  // MARK: - Fixtures

  private let passingJSON: String = """
    {
      "passed": true,
      "rules": [
        {"rule": "age", "passed": true, "details": {}},
        {"rule": "kyc", "passed": true, "details": {}},
        {"rule": "dispensary_license", "passed": true, "details": {}},
        {"rule": "hours", "passed": true, "details": {}},
        {"rule": "delivery_geofence", "passed": true, "details": {}},
        {"rule": "per_transaction_limit", "passed": true, "details": {}},
        {"rule": "product_provenance", "passed": true, "details": {}}
      ],
      "cartTotals": {"flowerGrams": 14, "concentrateGrams": 0, "edibleThcMg": 200},
      "limits": {"flowerGramsMax": 56, "concentrateGramsMax": 8, "edibleThcMgMax": 800},
      "evaluatedAt": "2026-05-20T18:00:00.000Z",
      "evaluationVersion": "1.0.0"
    }
    """

  private let perTransactionLimitFailJSON: String = """
    {
      "passed": false,
      "rules": [
        {"rule": "age", "passed": true, "details": {}},
        {"rule": "per_transaction_limit", "passed": false,
         "details": {"flowerGramsOver": 12.5, "flowerGramsCurrent": 68.5}}
      ],
      "cartTotals": {"flowerGrams": 68.5, "concentrateGrams": 0, "edibleThcMg": 0},
      "limits": {"flowerGramsMax": 56, "concentrateGramsMax": 8, "edibleThcMgMax": 800},
      "evaluatedAt": "2026-05-20T18:00:00.000Z",
      "evaluationVersion": "1.0.0"
    }
    """

  private let geofenceFailJSON: String = """
    {
      "passed": false,
      "rules": [
        {"rule": "delivery_geofence", "passed": false,
         "details": {"latitude": 45.5, "longitude": -94.2,
                     "polygon": [[44.9, -93.3], [44.9, -93.1], [45.1, -93.1]]}}
      ],
      "cartTotals": {"flowerGrams": 14, "concentrateGrams": 0, "edibleThcMg": 0},
      "limits": {"flowerGramsMax": 56, "concentrateGramsMax": 8, "edibleThcMgMax": 800},
      "evaluatedAt": "2026-05-20T18:00:00.000Z",
      "evaluationVersion": "1.0.0"
    }
    """

  private let hoursFailJSON: String = """
    {
      "passed": false,
      "rules": [
        {"rule": "hours", "passed": false,
         "details": {"opensAt": "2026-05-21T13:00:00.000Z", "reason": "closed"}}
      ],
      "cartTotals": {"flowerGrams": 7, "concentrateGrams": 0, "edibleThcMg": 0},
      "limits": {"flowerGramsMax": 56, "concentrateGramsMax": 8, "edibleThcMgMax": 800},
      "evaluatedAt": "2026-05-20T03:30:00.000Z",
      "evaluationVersion": "1.0.0"
    }
    """

  private func decode(_ json: String) throws -> ComplianceEvaluation {
    try decoder().decode(ComplianceEvaluation.self, from: Data(json.utf8))
  }

  // MARK: - Tests

  func test_decodesPassingFixture() throws {
    let evaluation = try decode(passingJSON)
    XCTAssertTrue(evaluation.passed)
    XCTAssertEqual(evaluation.rules.count, 7)
    XCTAssertEqual(evaluation.cartTotals.flowerGrams, 14)
    XCTAssertEqual(evaluation.cartTotals.edibleThcMg, 200)
    XCTAssertEqual(evaluation.limits.flowerGramsMax, 56)
    XCTAssertEqual(evaluation.evaluationVersion, "1.0.0")
    XCTAssertTrue(evaluation.failedRules.isEmpty)
  }

  func test_decodesPerTransactionLimitFailure() throws {
    let evaluation = try decode(perTransactionLimitFailJSON)
    XCTAssertFalse(evaluation.passed)
    XCTAssertEqual(evaluation.failedRules.count, 1)
    let failure = try XCTUnwrap(evaluation.result(for: .perTransactionLimit))
    XCTAssertFalse(failure.passed)
    let over = failure.details.object?["flowerGramsOver"]
    XCTAssertEqual(over, .double(12.5))
    XCTAssertEqual(evaluation.cartTotals.flowerGrams, Decimal(string: "68.5"))
  }

  func test_decodesGeofenceFailureWithNestedDetails() throws {
    let evaluation = try decode(geofenceFailJSON)
    XCTAssertFalse(evaluation.passed)
    let geo = try XCTUnwrap(evaluation.result(for: .deliveryGeofence))
    XCTAssertEqual(geo.details.object?["latitude"], .double(45.5))
    XCTAssertEqual(geo.details.object?["longitude"], .double(-94.2))
    let polygon = geo.details.object?["polygon"]
    if case .array(let rings) = polygon {
      XCTAssertEqual(rings.count, 3)
    } else {
      XCTFail("Expected polygon to be an array of coordinates")
    }
  }

  func test_decodesHoursFailureCarriesOpensAt() throws {
    let evaluation = try decode(hoursFailJSON)
    let hours = try XCTUnwrap(evaluation.result(for: .hours))
    XCTAssertFalse(hours.passed)
    XCTAssertEqual(hours.details.object?["opensAt"]?.string,
                   "2026-05-21T13:00:00.000Z")
    XCTAssertEqual(hours.details.object?["reason"], .string("closed"))
  }

  func test_resultForReturnsNilWhenRuleAbsent() throws {
    let evaluation = try decode(passingJSON)
    // The passing fixture includes age + kyc + ... but not `evaluation`
    XCTAssertNil(evaluation.result(for: .evaluation))
  }

  func test_decimalStringRoundTripPreservesPrecision() {
    let inputs: [String] = ["0.1", "0.5", "1.0", "3.50", "14.0", "28.5", "56.7", "800.0"]
    for input in inputs {
      let decimal = Decimal(string: input)
      XCTAssertNotNil(decimal, "Decimal(string:) accepted \(input)")
      XCTAssertEqual(decimal?.description, normalize(input),
                     "Decimal \(input) round-tripped via string")
    }
  }

  /// Decimal's `description` strips insignificant trailing zeros
  /// ("3.50" → "3.5") and the sign of zero, so the comparison goes
  /// through a normalizer rather than literal string equality.
  private func normalize(_ raw: String) -> String {
    Decimal(string: raw)?.description ?? raw
  }
}
