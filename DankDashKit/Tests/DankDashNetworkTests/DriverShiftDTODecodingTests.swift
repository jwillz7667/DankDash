import XCTest
import DankDashDomain
@testable import DankDashNetwork

final class DriverShiftDTODecodingTests: XCTestCase {
  private let decoder = JSONDecoder()
  private let encoder = JSONEncoder()

  // MARK: - Request encoding

  func test_startShiftRequest_encodesGeoJSONPoint() throws {
    let body = StartShiftRequestDTO(
      startingLocation: Coordinate(latitude: 44.9778, longitude: -93.2650)
    )
    let data = try encoder.encode(body)
    let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    let point = try XCTUnwrap(json["startingLocation"] as? [String: Any])
    XCTAssertEqual(point["type"] as? String, "Point")
    let coords = try XCTUnwrap(point["coordinates"] as? [Double])
    XCTAssertEqual(coords[0], -93.2650, "longitude leads — RFC-7946 + BoundedGeoPointSchema")
    XCTAssertEqual(coords[1], 44.9778)
  }

  func test_endShiftRequest_encodesGeoJSONPoint() throws {
    let body = EndShiftRequestDTO(
      endingLocation: Coordinate(latitude: 44.9778, longitude: -93.2650)
    )
    let data = try encoder.encode(body)
    let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertNotNil(json["endingLocation"])
  }

  // MARK: - Response decoding

  func test_openShift_decodesWithNullEnd() throws {
    let json = """
    {
      "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0A00",
      "driverId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0900",
      "startedAt": "2026-05-20T13:00:00.000Z",
      "endedAt": null,
      "startingLocation": { "type": "Point", "coordinates": [-93.2650, 44.9778] },
      "endingLocation": null,
      "totalMiles": null,
      "totalDeliveries": 0,
      "totalEarningsCents": 0
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(DriverShiftResponseDTO.self, from: json)
    let domain = try XCTUnwrap(dto.toDomain())
    XCTAssertTrue(domain.isActive)
    XCTAssertNil(domain.endedAt)
    XCTAssertNil(domain.endingLocation)
    XCTAssertNil(domain.totalMiles)
  }

  func test_closedShift_decodesAllFields() throws {
    let json = """
    {
      "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0A01",
      "driverId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0900",
      "startedAt": "2026-05-20T13:00:00.000Z",
      "endedAt": "2026-05-20T19:30:00.000Z",
      "startingLocation": { "type": "Point", "coordinates": [-93.2650, 44.9778] },
      "endingLocation": { "type": "Point", "coordinates": [-93.2700, 44.9810] },
      "totalMiles": "42.371",
      "totalDeliveries": 9,
      "totalEarningsCents": 18500
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(DriverShiftResponseDTO.self, from: json)
    let domain = try XCTUnwrap(dto.toDomain())
    XCTAssertFalse(domain.isActive)
    XCTAssertEqual(domain.totalMiles, Decimal(string: "42.371"))
    XCTAssertEqual(domain.totalDeliveries, 9)
    XCTAssertEqual(domain.totalEarningsCents, 18_500)
  }

  func test_shiftResponse_refusesMalformedTotalMiles() throws {
    let json = """
    {
      "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0A02",
      "driverId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0900",
      "startedAt": "2026-05-20T13:00:00.000Z",
      "endedAt": "2026-05-20T19:30:00.000Z",
      "startingLocation": null,
      "endingLocation": null,
      "totalMiles": "forty-two",
      "totalDeliveries": 9,
      "totalEarningsCents": 18500
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(DriverShiftResponseDTO.self, from: json)
    XCTAssertNil(dto.toDomain())
  }

  // MARK: - Status update request

  func test_updateStatusRequest_encodesOnlineString() throws {
    let body = UpdateDriverStatusRequestDTO(status: .online)
    let data = try encoder.encode(body)
    let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(json["status"] as? String, "online")
  }

  func test_updateStatusRequest_encodesOnBreakRawValue() throws {
    let body = UpdateDriverStatusRequestDTO(status: .onBreak)
    let data = try encoder.encode(body)
    let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(
      json["status"] as? String,
      "on_break",
      "matches the server's SelfSettableDriverStatus snake_case schema"
    )
  }
}
