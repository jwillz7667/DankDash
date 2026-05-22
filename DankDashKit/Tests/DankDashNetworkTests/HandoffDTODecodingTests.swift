import XCTest
import DankDashDomain
@testable import DankDashNetwork

final class HandoffDTODecodingTests: XCTestCase {
  private let decoder = JSONDecoder()
  private let encoder = JSONEncoder()

  // MARK: - Request encoding

  func test_handoffRequest_lowercasesBothUUIDs() throws {
    let cartId = UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0010")!
    let addressId = UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0030")!
    let body = CheckoutHandoffRequestDTO(cartId: cartId, deliveryAddressId: addressId)
    let json = try encoder.encode(body)
    let payload = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: json) as? [String: String]
    )
    XCTAssertEqual(payload["cartId"], "0190b7a4-9c00-72f5-a6b0-1c6f77ce0010")
    XCTAssertEqual(payload["deliveryAddressId"], "0190b7a4-9c00-72f5-a6b0-1c6f77ce0030")
  }

  // MARK: - Response decoding

  func test_handoffResponse_decodesAndProjectsToDomain() throws {
    let json = """
    {
      "handoffToken": "eyJhbGciOiJFZERTQSJ9.payload.signature",
      "exchangeUrl": "https://app.dankdash.com/checkout?handoff=eyJhbGciOiJFZERTQSJ9.payload.signature",
      "expiresAt": "2026-05-20T13:15:00.000Z"
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(CheckoutHandoffResponseDTO.self, from: json)
    let domain = try XCTUnwrap(dto.toDomain())
    XCTAssertEqual(domain.token, "eyJhbGciOiJFZERTQSJ9.payload.signature")
    XCTAssertEqual(
      domain.exchangeUrl.absoluteString,
      "https://app.dankdash.com/checkout?handoff=eyJhbGciOiJFZERTQSJ9.payload.signature"
    )
  }

  func test_handoffResponse_expiresAtIsFutureRelativeToReferenceDate() throws {
    // Clock-injected sanity check — the issuer mints with a 5-minute TTL.
    // We can't fake the clock inside the DTO, so we assert the projection
    // lands after our reference "now" using a fixture that's in 2026.
    let json = """
    {
      "handoffToken": "tk",
      "exchangeUrl": "https://app.dankdash.com/checkout?handoff=tk",
      "expiresAt": "2026-05-20T13:15:00.000Z"
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(CheckoutHandoffResponseDTO.self, from: json)
    let domain = try XCTUnwrap(dto.toDomain())

    // 2026-05-20T13:10:00 UTC — 5 minutes before the fixture expiry.
    var components = DateComponents()
    components.year = 2026; components.month = 5; components.day = 20
    components.hour = 13; components.minute = 10; components.second = 0
    components.timeZone = TimeZone(identifier: "UTC")
    let now = try XCTUnwrap(Calendar(identifier: .gregorian).date(from: components))

    XCTAssertGreaterThan(
      domain.expiresAt,
      now,
      "issuer mints with 5-min TTL; projection must round-trip a future Date for the reducer to detect 'not yet expired'"
    )
  }

  func test_handoffResponse_returnsNilOnMalformedExchangeUrl() throws {
    let json = """
    {
      "handoffToken": "tk",
      "exchangeUrl": "",
      "expiresAt": "2026-05-20T13:15:00.000Z"
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(CheckoutHandoffResponseDTO.self, from: json)
    XCTAssertNil(
      dto.toDomain(),
      "an empty exchangeUrl must reject the projection so Safari is never handed a bad URL"
    )
  }

  func test_handoffResponse_returnsNilOnMalformedExpiresAt() throws {
    let json = """
    {
      "handoffToken": "tk",
      "exchangeUrl": "https://app.dankdash.com/checkout?handoff=tk",
      "expiresAt": "not-a-timestamp"
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(CheckoutHandoffResponseDTO.self, from: json)
    XCTAssertNil(dto.toDomain())
  }
}
