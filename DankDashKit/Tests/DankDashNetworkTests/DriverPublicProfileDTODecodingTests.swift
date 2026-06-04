import XCTest
import DankDashDomain
@testable import DankDashNetwork

final class DriverPublicProfileDTODecodingTests: XCTestCase {
  private let decoder = JSONDecoder()

  func test_driverProfile_decodesAndProjectsToDomain() throws {
    let json = """
    {
      "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0500",
      "displayName": "Alex P.",
      "avatarKey": "drivers/0190b7a4-avatar.png",
      "vehicleSummary": "Silver Honda Civic",
      "maskedPhone": "+1•••-•••-1212"
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(DriverPublicProfileDTO.self, from: json)
    let domain = try XCTUnwrap(dto.toDomain())
    XCTAssertEqual(domain.id, UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0500"))
    XCTAssertEqual(domain.displayName, "Alex P.")
    XCTAssertEqual(domain.vehicleSummary, "Silver Honda Civic")
  }

  func test_driverProfile_returnsNilOnMalformedID() throws {
    let json = """
    {
      "id": "not-a-uuid",
      "displayName": "Alex P.",
      "avatarKey": null,
      "vehicleSummary": null,
      "maskedPhone": null
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(DriverPublicProfileDTO.self, from: json)
    XCTAssertNil(dto.toDomain())
  }

  func test_driverProfile_allowsNullOptionals() throws {
    let json = """
    {
      "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0500",
      "displayName": "Anon",
      "avatarKey": null,
      "vehicleSummary": null,
      "maskedPhone": null
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(DriverPublicProfileDTO.self, from: json)
    let domain = try XCTUnwrap(dto.toDomain())
    XCTAssertNil(domain.avatarKey)
    XCTAssertNil(domain.vehicleSummary)
    XCTAssertNil(domain.maskedPhone)
  }
}
