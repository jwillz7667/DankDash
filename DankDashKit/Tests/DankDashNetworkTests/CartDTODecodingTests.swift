import XCTest
import DankDashDomain
@testable import DankDashNetwork

final class CartDTODecodingTests: XCTestCase {
  private let decoder = JSONDecoder()
  private let encoder = JSONEncoder()

  // MARK: - Response decoding

  func test_cartDTO_decodesAndProjectsToDomain() throws {
    let dto = try decoder.decode(CartDTO.self, from: Self.cartJSON.data(using: .utf8)!)
    let domain = try XCTUnwrap(dto.toDomain())

    XCTAssertEqual(domain.id, UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0010"))
    XCTAssertEqual(domain.userId, UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0020"))
    XCTAssertEqual(domain.dispensaryId, UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0001"))
    XCTAssertEqual(domain.items.count, 2)
    XCTAssertEqual(domain.subtotalCents, 8_400)
    XCTAssertEqual(
      domain.items.first?.listingId,
      UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0101")
    )
    XCTAssertEqual(domain.items.first?.quantity, 2)
    XCTAssertEqual(domain.items.first?.unitPriceCents, 3_500)
    XCTAssertEqual(domain.items.first?.lineSubtotalCents, 7_000)
  }

  func test_cartDTO_decodesPromoFields() throws {
    let dto = try decoder.decode(CartDTO.self, from: Self.promoCartJSON.data(using: .utf8)!)
    let domain = try XCTUnwrap(dto.toDomain())

    XCTAssertEqual(dto.promoCode, "SAVE10")
    XCTAssertEqual(dto.discountCents, 500)
    XCTAssertEqual(domain.promoCode, "SAVE10")
    XCTAssertEqual(domain.discountCents, 500)
    XCTAssertEqual(domain.discountedSubtotalCents, 7_900)
    XCTAssertTrue(domain.hasPromo)
  }

  func test_cartDTO_backwardCompatible_whenPromoFieldsAbsent() throws {
    // A server that predates the promo feature omits both fields entirely.
    let dto = try decoder.decode(CartDTO.self, from: Self.cartJSON.data(using: .utf8)!)
    let domain = try XCTUnwrap(dto.toDomain())

    XCTAssertNil(dto.promoCode)
    XCTAssertEqual(dto.discountCents, 0, "absent discountCents defaults to 0")
    XCTAssertNil(domain.promoCode)
    XCTAssertEqual(domain.discountCents, 0)
    XCTAssertFalse(domain.hasPromo)
  }

  func test_cartDTO_decodesNullPromoCode() throws {
    let json = Self.cartJSON.replacingOccurrences(
      of: "\"subtotalCents\": 8400,",
      with: "\"subtotalCents\": 8400,\n  \"promoCode\": null,\n  \"discountCents\": 0,"
    )
    let dto = try decoder.decode(CartDTO.self, from: json.data(using: .utf8)!)

    XCTAssertNil(dto.promoCode)
    XCTAssertEqual(dto.discountCents, 0)
  }

  func test_cartDTO_refusesWholeCart_ifAnyItemMalformed() throws {
    let bad = Self.cartJSON.replacingOccurrences(
      of: "\"id\": \"0190B7A4-9C00-72F5-A6B0-1C6F77CE0301\"",
      with: "\"id\": \"not-a-uuid\""
    )
    let dto = try decoder.decode(CartDTO.self, from: bad.data(using: .utf8)!)
    XCTAssertNil(
      dto.toDomain(),
      "the cart is the system of record for what the user is about to pay; a malformed line must refuse the whole projection"
    )
  }

  func test_cartDTO_refusesWholeCart_ifExpiresAtMalformed() throws {
    let bad = Self.cartJSON.replacingOccurrences(
      of: "\"expiresAt\": \"2026-05-20T13:30:00.000Z\"",
      with: "\"expiresAt\": \"not-a-timestamp\""
    )
    let dto = try decoder.decode(CartDTO.self, from: bad.data(using: .utf8)!)
    XCTAssertNil(dto.toDomain())
  }

  func test_cartItemDTO_returnsNilOnMalformedListingId() throws {
    let json = """
    {
      "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0301",
      "listingId": "not-a-uuid",
      "quantity": 1,
      "unitPriceCents": 1000,
      "lineSubtotalCents": 1000,
      "createdAt": "2026-05-20T13:00:00.000Z",
      "updatedAt": "2026-05-20T13:00:00.000Z"
    }
    """
    let dto = try decoder.decode(CartItemDTO.self, from: json.data(using: .utf8)!)
    XCTAssertNil(dto.toDomain())
  }

  // MARK: - Request encoding

  func test_createCartRequest_lowercasesUUID() throws {
    let id = UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0001")!
    let body = CreateCartRequestDTO(dispensaryId: id)
    let json = try encoder.encode(body)
    let payload = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: json) as? [String: String]
    )
    XCTAssertEqual(payload["dispensaryId"], "0190b7a4-9c00-72f5-a6b0-1c6f77ce0001")
  }

  func test_addCartItemRequest_lowercasesListingId() throws {
    let listingId = UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0101")!
    let body = AddCartItemRequestDTO(listingId: listingId, quantity: 3)
    let json = try encoder.encode(body)
    let payload = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: json) as? [String: Any]
    )
    XCTAssertEqual(payload["listingId"] as? String, "0190b7a4-9c00-72f5-a6b0-1c6f77ce0101")
    XCTAssertEqual(payload["quantity"] as? Int, 3)
  }

  func test_patchCartItemRequest_zeroQuantityShipsLiterally() throws {
    let body = PatchCartItemRequestDTO(quantity: 0)
    let json = try encoder.encode(body)
    let payload = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: json) as? [String: Int]
    )
    XCTAssertEqual(payload["quantity"], 0)
  }

  // MARK: - Fixtures

  private static let cartJSON = """
  {
    "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0010",
    "userId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0020",
    "dispensaryId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0001",
    "items": [
      {
        "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0301",
        "listingId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0101",
        "quantity": 2,
        "unitPriceCents": 3500,
        "lineSubtotalCents": 7000,
        "createdAt": "2026-05-20T13:00:00.000Z",
        "updatedAt": "2026-05-20T13:00:00.000Z"
      },
      {
        "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0302",
        "listingId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0102",
        "quantity": 1,
        "unitPriceCents": 1400,
        "lineSubtotalCents": 1400,
        "createdAt": "2026-05-20T13:05:00.000Z",
        "updatedAt": "2026-05-20T13:05:00.000Z"
      }
    ],
    "subtotalCents": 8400,
    "expiresAt": "2026-05-20T13:30:00.000Z",
    "createdAt": "2026-05-20T13:00:00.000Z",
    "updatedAt": "2026-05-20T13:05:00.000Z"
  }
  """

  private static let promoCartJSON = """
  {
    "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0010",
    "userId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0020",
    "dispensaryId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0001",
    "items": [
      {
        "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0301",
        "listingId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0101",
        "quantity": 2,
        "unitPriceCents": 3500,
        "lineSubtotalCents": 7000,
        "createdAt": "2026-05-20T13:00:00.000Z",
        "updatedAt": "2026-05-20T13:00:00.000Z"
      },
      {
        "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0302",
        "listingId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0102",
        "quantity": 1,
        "unitPriceCents": 1400,
        "lineSubtotalCents": 1400,
        "createdAt": "2026-05-20T13:05:00.000Z",
        "updatedAt": "2026-05-20T13:05:00.000Z"
      }
    ],
    "subtotalCents": 8400,
    "promoCode": "SAVE10",
    "discountCents": 500,
    "expiresAt": "2026-05-20T13:30:00.000Z",
    "createdAt": "2026-05-20T13:00:00.000Z",
    "updatedAt": "2026-05-20T13:05:00.000Z"
  }
  """
}
