import XCTest
import DankDashDomain
@testable import DankDashNetwork

final class PaymentMethodDTODecodingTests: XCTestCase {
  private let decoder = JSONDecoder()
  private let encoder = JSONEncoder()

  // MARK: - Response decoding

  func test_paymentMethodDTO_decodesAndProjectsToDomain() throws {
    let dto = try decoder.decode(
      PaymentMethodResponseDTO.self,
      from: Self.activeBankJSON.data(using: .utf8)!
    )
    let domain = try XCTUnwrap(dto.toDomain())
    XCTAssertEqual(domain.id, UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CEAAA1"))
    XCTAssertEqual(domain.type, .aeropayACH)
    XCTAssertEqual(domain.aeropayPaymentMethodRef, "ba_test_123")
    XCTAssertEqual(domain.bankName, "Test Bank")
    XCTAssertEqual(domain.last4, "1234")
    XCTAssertTrue(domain.isDefault)
    XCTAssertEqual(domain.status, .active)
    XCTAssertTrue(domain.isUsable)
    XCTAssertEqual(domain.displayName, "Test Bank ••1234")
  }

  func test_paymentMethodDTO_pendingRow_hasNullBankMetadata() throws {
    let dto = try decoder.decode(
      PaymentMethodResponseDTO.self,
      from: Self.pendingBankJSON.data(using: .utf8)!
    )
    let domain = try XCTUnwrap(dto.toDomain())
    XCTAssertEqual(domain.status, .pending)
    XCTAssertNil(domain.bankName)
    XCTAssertNil(domain.last4)
    XCTAssertFalse(domain.isUsable)
    XCTAssertEqual(domain.displayName, "Bank account", "a pending row with no metadata falls back to the type label")
  }

  func test_paymentMethodDTO_returnsNilOnMalformedID() throws {
    let bad = Self.activeBankJSON.replacingOccurrences(
      of: "\"id\": \"0190B7A4-9C00-72F5-A6B0-1C6F77CEAAA1\"",
      with: "\"id\": \"not-a-uuid\""
    )
    let dto = try decoder.decode(PaymentMethodResponseDTO.self, from: bad.data(using: .utf8)!)
    XCTAssertNil(dto.toDomain())
  }

  func test_paymentMethodDTO_returnsNilOnUnknownType() throws {
    let bad = Self.activeBankJSON.replacingOccurrences(
      of: "\"type\": \"aeropay_ach\"",
      with: "\"type\": \"crypto_wallet\""
    )
    let dto = try decoder.decode(PaymentMethodResponseDTO.self, from: bad.data(using: .utf8)!)
    XCTAssertNil(dto.toDomain(), "an unknown funding type must drop the row, not crash")
  }

  func test_paymentMethodDTO_returnsNilOnUnknownStatus() throws {
    let bad = Self.activeBankJSON.replacingOccurrences(
      of: "\"status\": \"active\"",
      with: "\"status\": \"frozen\""
    )
    let dto = try decoder.decode(PaymentMethodResponseDTO.self, from: bad.data(using: .utf8)!)
    XCTAssertNil(dto.toDomain())
  }

  func test_listPaymentMethods_dropsMalformedRow() throws {
    let json = """
    {
      "paymentMethods": [
        \(Self.activeBankJSON),
        {
          "id": "not-a-uuid",
          "type": "aeropay_ach",
          "aeropayPaymentMethodRef": null,
          "bankName": null,
          "last4": null,
          "isDefault": false,
          "status": "pending",
          "createdAt": "2026-05-19T20:00:00.000Z",
          "updatedAt": "2026-05-19T20:00:00.000Z"
        }
      ]
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(ListPaymentMethodsResponseDTO.self, from: json)
    let domain = dto.toDomain()
    XCTAssertEqual(domain.count, 1, "rows compactMap — one bad row should not black-hole the list")
  }

  func test_linkResponse_decodesPendingMethodAndSession() throws {
    let dto = try decoder.decode(
      LinkAeropayResponseDTO.self,
      from: Self.linkResponseJSON.data(using: .utf8)!
    )
    XCTAssertEqual(dto.paymentMethod.status, "pending")
    let session = try XCTUnwrap(dto.link.toDomain())
    XCTAssertEqual(session.id, "link_session_test_1")
    XCTAssertEqual(session.hostedUrl, URL(string: "https://link.aeropay.com/session/test_1"))
    XCTAssertNotNil(session.expiresAt)
  }

  func test_linkSession_returnsNilOnRelativeHostedUrl() throws {
    let dto = AeropayLinkSessionResponseDTO(
      id: "s1",
      hostedUrl: "/relative/path",
      expiresAt: "2026-05-19T23:00:00.000Z"
    )
    XCTAssertNil(dto.toDomain(), "a scheme-less URL is not a usable hosted link")
  }

  func test_envelopeResponse_decodesPromotedMethod() throws {
    let json = """
    { "paymentMethod": \(Self.activeBankJSON) }
    """.data(using: .utf8)!
    let dto = try decoder.decode(PaymentMethodEnvelopeResponseDTO.self, from: json)
    XCTAssertEqual(dto.paymentMethod.toDomain()?.isDefault, true)
  }

  // MARK: - Request encoding

  func test_linkRequest_encodesReturnUrl() throws {
    let body = LinkAeropayRequestDTO(returnUrl: "https://app.dankdash.com/payment-methods/linked")
    let payload = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: encoder.encode(body)) as? [String: Any]
    )
    XCTAssertEqual(payload.keys.sorted(), ["returnUrl"])
    XCTAssertEqual(payload["returnUrl"] as? String, "https://app.dankdash.com/payment-methods/linked")
  }

  func test_setDefaultRequest_alwaysShipsLiteralTrue() throws {
    let body = SetDefaultPaymentMethodRequestDTO()
    let payload = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: encoder.encode(body)) as? [String: Any]
    )
    XCTAssertEqual(
      payload.keys.sorted(),
      ["isDefault"],
      "the server validates isDefault as z.literal(true) — the body must carry exactly that"
    )
    XCTAssertEqual(payload["isDefault"] as? Bool, true)
  }

  // MARK: - Fixtures

  private static let activeBankJSON = """
  {
    "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CEAAA1",
    "type": "aeropay_ach",
    "aeropayPaymentMethodRef": "ba_test_123",
    "bankName": "Test Bank",
    "last4": "1234",
    "isDefault": true,
    "status": "active",
    "createdAt": "2026-05-19T20:00:00.000Z",
    "updatedAt": "2026-05-19T20:00:00.000Z"
  }
  """

  private static let pendingBankJSON = """
  {
    "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CEAAA2",
    "type": "aeropay_ach",
    "aeropayPaymentMethodRef": "link_session_test_1",
    "bankName": null,
    "last4": null,
    "isDefault": false,
    "status": "pending",
    "createdAt": "2026-05-19T20:00:00.000Z",
    "updatedAt": "2026-05-19T20:00:00.000Z"
  }
  """

  private static let linkResponseJSON = """
  {
    "paymentMethod": \(pendingBankJSON),
    "link": {
      "id": "link_session_test_1",
      "hostedUrl": "https://link.aeropay.com/session/test_1",
      "expiresAt": "2026-05-19T23:00:00.000Z"
    }
  }
  """
}
