import XCTest
@testable import DankDashDomain

/// `AnyValue` is the wire-bridge for free-form server payloads
/// (productSnapshot on order items, details on a rule result, payload
/// on an order event). The Codable round-trip is the whole contract —
/// these tests cover every JSON kind plus the int-vs-double
/// discriminator preservation that makes the type useful.
final class AnyValueTests: XCTestCase {
  private func roundTrip(_ value: AnyValue) throws -> AnyValue {
    let data = try JSONEncoder().encode(value)
    return try JSONDecoder().decode(AnyValue.self, from: data)
  }

  func test_decodesAndEncodesNull() throws {
    let value = try JSONDecoder().decode(AnyValue.self, from: Data("null".utf8))
    XCTAssertEqual(value, .null)
    let encoded = try JSONEncoder().encode(value)
    XCTAssertEqual(String(data: encoded, encoding: .utf8), "null")
  }

  func test_decodesBoolBeforeInt() throws {
    let trueValue = try JSONDecoder().decode(AnyValue.self, from: Data("true".utf8))
    XCTAssertEqual(trueValue, .bool(true), "`true` decodes as bool, not as 1")

    let falseValue = try JSONDecoder().decode(AnyValue.self, from: Data("false".utf8))
    XCTAssertEqual(falseValue, .bool(false))
  }

  func test_keepsIntDistinctFromDouble() throws {
    let intValue = try JSONDecoder().decode(AnyValue.self, from: Data("42".utf8))
    XCTAssertEqual(intValue, .int(42), "integer JSON literals keep the .int case")

    let doubleValue = try JSONDecoder().decode(AnyValue.self, from: Data("3.14".utf8))
    XCTAssertEqual(doubleValue, .double(3.14))
  }

  func test_decodesString() throws {
    let value = try JSONDecoder().decode(AnyValue.self, from: Data(#""hello""#.utf8))
    XCTAssertEqual(value, .string("hello"))
  }

  func test_decodesArray() throws {
    let value = try JSONDecoder().decode(
      AnyValue.self,
      from: Data(#"[1, "two", true, null]"#.utf8)
    )
    XCTAssertEqual(value, .array([.int(1), .string("two"), .bool(true), .null]))
  }

  func test_decodesObject() throws {
    let value = try JSONDecoder().decode(
      AnyValue.self,
      from: Data(#"{"key": "value", "n": 42}"#.utf8)
    )
    XCTAssertEqual(value.object?["key"], .string("value"))
    XCTAssertEqual(value.object?["n"], .int(42))
  }

  func test_decodesNestedObject() throws {
    let value = try JSONDecoder().decode(
      AnyValue.self,
      from: Data(#"{"outer": {"inner": [1, 2, 3]}}"#.utf8)
    )
    let inner = value.object?["outer"]?.object?["inner"]
    XCTAssertEqual(inner, .array([.int(1), .int(2), .int(3)]))
  }

  func test_roundTripsObject() throws {
    let original = AnyValue.object([
      "id": .string("01923456-789a-7bcd-ef01-23456789abcd"),
      "qty": .int(2),
      "weight": .double(3.5),
      "active": .bool(true),
      "removed": .null,
      "tags": .array([.string("indica"), .string("hybrid")]),
    ])
    let back = try roundTrip(original)
    XCTAssertEqual(back, original)
  }

  func test_objectAccessorReturnsNilForNonObject() {
    XCTAssertNil(AnyValue.string("x").object)
    XCTAssertNil(AnyValue.int(1).object)
    XCTAssertNil(AnyValue.null.object)
  }

  func test_stringAccessorReturnsNilForNonString() {
    XCTAssertNil(AnyValue.int(1).string)
    XCTAssertNil(AnyValue.null.string)
  }
}
