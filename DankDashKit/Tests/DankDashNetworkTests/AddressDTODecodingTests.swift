import XCTest
import DankDashDomain
@testable import DankDashNetwork

final class AddressDTODecodingTests: XCTestCase {
  private let decoder = JSONDecoder()
  private let encoder = JSONEncoder()

  // MARK: - Response decoding

  func test_addressDTO_decodesAndProjectsToDomain() throws {
    let dto = try decoder.decode(
      UserAddressResponseDTO.self,
      from: Self.singleAddressJSON.data(using: .utf8)!
    )
    let domain = try XCTUnwrap(dto.toDomain())
    XCTAssertEqual(domain.id, UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0030"))
    XCTAssertEqual(domain.label, "Home")
    XCTAssertEqual(domain.line1, "1100 Hennepin Ave")
    XCTAssertEqual(domain.line2, "Apt 204")
    XCTAssertEqual(domain.city, "Minneapolis")
    XCTAssertEqual(domain.region, "MN")
    XCTAssertEqual(domain.location.latitude, 44.9778, accuracy: 0.0001)
    XCTAssertEqual(domain.location.longitude, -93.2650, accuracy: 0.0001)
    XCTAssertTrue(domain.isDefault)
    XCTAssertTrue(domain.isValidated)
    XCTAssertNotNil(domain.validatedAt)
  }

  func test_addressDTO_returnsNilOnMalformedID() throws {
    let bad = Self.singleAddressJSON.replacingOccurrences(
      of: "\"id\": \"0190B7A4-9C00-72F5-A6B0-1C6F77CE0030\"",
      with: "\"id\": \"not-a-uuid\""
    )
    let dto = try decoder.decode(UserAddressResponseDTO.self, from: bad.data(using: .utf8)!)
    XCTAssertNil(dto.toDomain())
  }

  func test_addressDTO_returnsNilOnMalformedValidatedAt() throws {
    let bad = Self.singleAddressJSON.replacingOccurrences(
      of: "\"validatedAt\": \"2026-05-19T20:00:00.000Z\"",
      with: "\"validatedAt\": \"not-a-timestamp\""
    )
    let dto = try decoder.decode(UserAddressResponseDTO.self, from: bad.data(using: .utf8)!)
    XCTAssertNil(dto.toDomain())
  }

  func test_addressDTO_allowsNullValidatedAt() throws {
    let bad = Self.singleAddressJSON.replacingOccurrences(
      of: "\"validatedAt\": \"2026-05-19T20:00:00.000Z\"",
      with: "\"validatedAt\": null"
    )
    let dto = try decoder.decode(UserAddressResponseDTO.self, from: bad.data(using: .utf8)!)
    let domain = try XCTUnwrap(dto.toDomain())
    XCTAssertNil(domain.validatedAt)
  }

  func test_listAddresses_dropsMalformedRow() throws {
    let json = """
    {
      "addresses": [
        \(Self.singleAddressJSON),
        {
          "id": "not-a-uuid",
          "label": null,
          "line1": "1",
          "line2": null,
          "city": "X",
          "region": "MN",
          "postalCode": "00000",
          "country": "US",
          "location": { "latitude": 0, "longitude": 0 },
          "isDefault": false,
          "isValidated": false,
          "validatedAt": null,
          "deliveryInstructions": null,
          "createdAt": "2026-05-19T20:00:00.000Z",
          "updatedAt": "2026-05-19T20:00:00.000Z"
        }
      ]
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(ListAddressesResponseDTO.self, from: json)
    let domain = dto.toDomain()
    XCTAssertEqual(
      domain.count,
      1,
      "address list rows compactMap — one bad row should not black-hole the picker"
    )
  }

  // MARK: - Request encoding

  func test_createAddressRequest_encodesOptionalSetAsDefault() throws {
    let body = CreateAddressRequestDTO(
      label: "Home",
      line1: "1100 Hennepin Ave",
      city: "Minneapolis",
      region: "MN",
      postalCode: "55403",
      latitude: 44.9778,
      longitude: -93.2650,
      setAsDefault: true
    )
    let json = try encoder.encode(body)
    let payload = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: json) as? [String: Any]
    )
    XCTAssertEqual(payload["label"] as? String, "Home")
    XCTAssertEqual(payload["line1"] as? String, "1100 Hennepin Ave")
    XCTAssertEqual(payload["region"] as? String, "MN")
    XCTAssertEqual(payload["country"] as? String, "US")
    XCTAssertEqual(payload["setAsDefault"] as? Bool, true)
  }

  func test_patchAddressRequest_omitsNilKeys() throws {
    let body = PatchAddressRequestDTO(isDefault: true)
    let json = try encoder.encode(body)
    let payload = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: json) as? [String: Any]
    )
    XCTAssertEqual(
      payload.keys.sorted(),
      ["isDefault"],
      "an all-nil-except-isDefault patch must ship exactly one key — the server rejects all-null bodies with 422 'at least one field must be provided'"
    )
    XCTAssertEqual(payload["isDefault"] as? Bool, true)
  }

  func test_patchAddressRequest_omitsCoordinateWhenOnlyOnePresent_isCallerResponsibility() throws {
    // The server rejects a patch with one of lat/lng but not the other.
    // The DTO itself doesn't enforce the pair (it just ships present
    // fields verbatim); the cart/feature reducer pairs them. This test
    // pins the documented behaviour so a future refactor doesn't silently
    // start filtering.
    let body = PatchAddressRequestDTO(latitude: 44.9778)
    let json = try encoder.encode(body)
    let payload = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: json) as? [String: Any]
    )
    XCTAssertEqual(payload["latitude"] as? Double, 44.9778)
    XCTAssertFalse(payload.keys.contains("longitude"))
  }

  // MARK: - Fixtures

  private static let singleAddressJSON = """
  {
    "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0030",
    "label": "Home",
    "line1": "1100 Hennepin Ave",
    "line2": "Apt 204",
    "city": "Minneapolis",
    "region": "MN",
    "postalCode": "55403",
    "country": "US",
    "location": { "latitude": 44.9778, "longitude": -93.2650 },
    "isDefault": true,
    "isValidated": true,
    "validatedAt": "2026-05-19T20:00:00.000Z",
    "deliveryInstructions": "Buzz #204",
    "createdAt": "2026-05-19T20:00:00.000Z",
    "updatedAt": "2026-05-19T20:00:00.000Z"
  }
  """
}
