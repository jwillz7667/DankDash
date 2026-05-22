import XCTest
import DankDashDomain
@testable import DankDashNetwork

/// Wire-shape pinning for the driver self-projection. Mirrors the
/// Phase-8 `DriverResponseSchema` — UUIDs, ISO-8601 timestamps,
/// `yyyy-MM-dd` calendar dates, the flat `vehicle*` columns, and a
/// `NUMERIC_STRING` `ratingAvg`.
final class DriverDTODecodingTests: XCTestCase {
  private let decoder = JSONDecoder()

  func test_driverResponse_decodesAndProjectsToDomain() throws {
    let dto = try decoder.decode(DriverResponseDTO.self, from: Self.driverJSON.data(using: .utf8)!)
    let domain = try XCTUnwrap(dto.toDomain())

    XCTAssertEqual(domain.id, UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0900"))
    XCTAssertEqual(domain.userId, UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0901"))
    XCTAssertEqual(domain.vehicle.make, "Honda")
    XCTAssertEqual(domain.vehicle.model, "Civic")
    XCTAssertEqual(domain.vehicle.year, 2021)
    XCTAssertEqual(domain.vehicle.plate, "ABC123")
    XCTAssertEqual(domain.vehicle.color, "Blue")
    XCTAssertEqual(domain.insuranceDocKey, "drivers/insurance/abc.pdf")
    XCTAssertEqual(domain.insuranceExpiresAt, "2027-04-30")
    XCTAssertEqual(domain.backgroundCheckPassedAt, "2026-04-15")
    XCTAssertEqual(domain.currentStatus, .online)
    XCTAssertEqual(domain.ratingAvg, Decimal(string: "4.87"))
    XCTAssertEqual(domain.ratingCount, 142)
    XCTAssertEqual(domain.totalDeliveries, 312)
    XCTAssertEqual(domain.currentLocation?.latitude, 44.9778)
    XCTAssertEqual(domain.currentLocation?.longitude, -93.2650)
  }

  func test_driverResponse_nilLocationProjectsCleanly() throws {
    let json = Self.driverJSON.replacingOccurrences(
      of: "\"currentLocation\": { \"type\": \"Point\", \"coordinates\": [-93.2650, 44.9778] }",
      with: "\"currentLocation\": null"
    )
    let dto = try decoder.decode(DriverResponseDTO.self, from: json.data(using: .utf8)!)
    let domain = try XCTUnwrap(dto.toDomain())
    XCTAssertNil(domain.currentLocation)
  }

  func test_driverResponse_returnsNilOnUnknownStatus() throws {
    let json = Self.driverJSON.replacingOccurrences(
      of: "\"currentStatus\": \"online\"",
      with: "\"currentStatus\": \"floating_in_limbo\""
    )
    let dto = try decoder.decode(DriverResponseDTO.self, from: json.data(using: .utf8)!)
    XCTAssertNil(dto.toDomain())
  }

  func test_driverResponse_returnsNilOnMalformedRatingAvg() throws {
    // Foundation's `Decimal(string:)` returns 0 for `"four point eight"`
    // — the regex-validated parser must refuse so a malformed wire
    // value can't silently flatten the dispatch-quality signal.
    let json = Self.driverJSON.replacingOccurrences(
      of: "\"ratingAvg\": \"4.87\"",
      with: "\"ratingAvg\": \"four point eight seven\""
    )
    let dto = try decoder.decode(DriverResponseDTO.self, from: json.data(using: .utf8)!)
    XCTAssertNil(dto.toDomain())
  }

  func test_driverResponse_allowsNullRatingForNewDriver() throws {
    let json = Self.driverJSON
      .replacingOccurrences(of: "\"ratingAvg\": \"4.87\"", with: "\"ratingAvg\": null")
      .replacingOccurrences(of: "\"ratingCount\": 142", with: "\"ratingCount\": 0")
    let dto = try decoder.decode(DriverResponseDTO.self, from: json.data(using: .utf8)!)
    let domain = try XCTUnwrap(dto.toDomain())
    XCTAssertNil(domain.ratingAvg)
    XCTAssertNil(domain.ratingDisplay)
  }

  func test_driverResponse_currentLocationWithBadGeoJSONFails() throws {
    let json = Self.driverJSON.replacingOccurrences(
      of: "\"type\": \"Point\", \"coordinates\": [-93.2650, 44.9778]",
      with: "\"type\": \"Polygon\", \"coordinates\": [-93.2650, 44.9778]"
    )
    let dto = try decoder.decode(DriverResponseDTO.self, from: json.data(using: .utf8)!)
    XCTAssertNil(dto.toDomain())
  }

  // MARK: - Fixture

  static let driverJSON: String = """
  {
    "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0900",
    "userId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0901",
    "vehicleMake": "Honda",
    "vehicleModel": "Civic",
    "vehicleYear": 2021,
    "vehiclePlate": "ABC123",
    "vehicleColor": "Blue",
    "insuranceDocKey": "drivers/insurance/abc.pdf",
    "insuranceExpiresAt": "2027-04-30",
    "backgroundCheckPassedAt": "2026-04-15",
    "backgroundCheckProviderRef": "checkr_a1b2c3",
    "currentStatus": "online",
    "lastStatusChangeAt": "2026-05-20T13:00:00.000Z",
    "currentLocation": { "type": "Point", "coordinates": [-93.2650, 44.9778] },
    "currentLocationUpdatedAt": "2026-05-20T13:00:00.000Z",
    "currentOrderId": null,
    "ratingAvg": "4.87",
    "ratingCount": 142,
    "totalDeliveries": 312,
    "createdAt": "2026-01-15T08:00:00.000Z",
    "updatedAt": "2026-05-20T13:00:00.000Z"
  }
  """
}
