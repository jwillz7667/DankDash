import XCTest
@testable import DankDashNetwork

/// Decoding tests for the checkout response shapes. The client only
/// projects the fields it needs (order identity + payment provider), so
/// these assert that extra server keys are tolerated and that the
/// `orderId` helper parses (or rejects) the embedded id.
final class CheckoutDTODecodingTests: XCTestCase {
  private let decoder = JSONDecoder()

  func test_capabilities_decodesBypassFlag() throws {
    let json = Data(#"{"paymentBypassEnabled":true}"#.utf8)
    let dto = try decoder.decode(CheckoutCapabilitiesResponseDTO.self, from: json)
    XCTAssertTrue(dto.paymentBypassEnabled)
  }

  func test_checkoutResponse_decodesOrderAndIntent_ignoringUnknownKeys() throws {
    // Includes the full server envelope (complianceCheck, totals, extra
    // order fields) the client does not model — decoding must ignore them.
    let json = Data(#"""
    {
      "order": {
        "id": "0190b7a4-9c00-72f5-a6b0-1c6f77ce1000",
        "shortCode": "3F9A2K",
        "userId": "0190b7a4-9c00-72f5-a6b0-1c6f77ce0001",
        "status": "placed",
        "subtotalCents": 9000,
        "totalCents": 11019,
        "items": []
      },
      "paymentIntent": {
        "id": "0190b7a4-9c00-72f5-a6b0-1c6f77ce4000",
        "orderId": "0190b7a4-9c00-72f5-a6b0-1c6f77ce1000",
        "provider": "bypass",
        "providerRef": "bypass_3F9A2K",
        "status": "authorized",
        "amountCents": 11019,
        "clientSecret": null
      },
      "complianceCheck": { "passed": true }
    }
    """#.utf8)

    let dto = try decoder.decode(CheckoutResponseDTO.self, from: json)

    XCTAssertEqual(dto.order.shortCode, "3F9A2K")
    XCTAssertEqual(dto.order.status, "placed")
    XCTAssertEqual(dto.paymentIntent.provider, "bypass")
    XCTAssertEqual(dto.paymentIntent.status, "authorized")
    XCTAssertEqual(dto.orderId, UUID(uuidString: "0190b7a4-9c00-72f5-a6b0-1c6f77ce1000"))
  }

  func test_checkoutResponse_orderId_isNilForMalformedId() throws {
    let json = Data(#"""
    {
      "order": { "id": "not-a-uuid", "shortCode": "ABCDEF", "status": "placed" },
      "paymentIntent": { "provider": "aeropay", "status": "initiated" }
    }
    """#.utf8)

    let dto = try decoder.decode(CheckoutResponseDTO.self, from: json)
    XCTAssertNil(dto.orderId)
  }
}
