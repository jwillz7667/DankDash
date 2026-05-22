import XCTest
@testable import DankDashNetwork

final class ErrorEnvelopeTests: XCTestCase {
  private let decoder = JSONDecoder()

  func test_envelope_decodesWithRequestID() throws {
    let json = """
    {
      "error": {
        "code": "AUTH_INVALID_CREDENTIALS",
        "message": "Invalid email or password",
        "details": {},
        "request_id": "req_abc123"
      }
    }
    """.data(using: .utf8)!
    let envelope = try decoder.decode(ErrorEnvelope.self, from: json)
    XCTAssertEqual(envelope.error.code, "AUTH_INVALID_CREDENTIALS")
    XCTAssertEqual(envelope.error.message, "Invalid email or password")
    XCTAssertEqual(envelope.error.requestId, "req_abc123")
  }

  func test_envelope_decodesWithoutRequestID() throws {
    let json = """
    {
      "error": {
        "code": "VALIDATION_ERROR",
        "message": "email must be a valid email",
        "details": { "field": "email" }
      }
    }
    """.data(using: .utf8)!
    let envelope = try decoder.decode(ErrorEnvelope.self, from: json)
    XCTAssertEqual(envelope.error.code, "VALIDATION_ERROR")
    XCTAssertNil(envelope.error.requestId)
    if case .object(let fields) = envelope.error.details {
      XCTAssertEqual(fields["field"]?.stringValue, "email")
    } else {
      XCTFail("expected details.object")
    }
  }

  func test_envelope_defaultsDetailsToEmptyObject() throws {
    let json = """
    { "error": { "code": "X", "message": "Y" } }
    """.data(using: .utf8)!
    let envelope = try decoder.decode(ErrorEnvelope.self, from: json)
    XCTAssertEqual(envelope.error.details, .object([:]))
  }

  func test_jsonValue_decodesScalars() throws {
    XCTAssertEqual(try decoder.decode(JSONValue.self, from: "true".data(using: .utf8)!), .bool(true))
    XCTAssertEqual(try decoder.decode(JSONValue.self, from: "42".data(using: .utf8)!), .number(42))
    XCTAssertEqual(try decoder.decode(JSONValue.self, from: "\"hi\"".data(using: .utf8)!), .string("hi"))
    XCTAssertEqual(try decoder.decode(JSONValue.self, from: "null".data(using: .utf8)!), .null)
  }
}
