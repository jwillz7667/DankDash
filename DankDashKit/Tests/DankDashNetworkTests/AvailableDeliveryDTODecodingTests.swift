import XCTest
import DankDashDomain
@testable import DankDashNetwork

/// Wire-shape pinning for the open-pool delivery surface
/// (`GET /v1/driver/deliveries/available`, `.../claim`). Guards the
/// nested `{ lat, lng }` coordinate decode + the lossy `toDomain`
/// projection that drops individually-malformed rows.
final class AvailableDeliveryDTODecodingTests: XCTestCase {
  private let decoder = JSONDecoder()

  func test_availableDeliveriesResponse_decodesAndProjects() throws {
    let json = """
    {
      "deliveries": [
        {
          "orderId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0400",
          "shortCode": "7Q4K",
          "dispensaryId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0D00",
          "pickupName": "Bloom Dispensary",
          "pickup": { "lat": 44.9778, "lng": -93.2650 },
          "dropoff": { "lat": 44.9836, "lng": -93.2766 },
          "tipCents": 650,
          "totalCents": 8240,
          "distanceMeters": 2100.5,
          "awaitingDriverAt": "2026-05-20T13:10:00.000Z"
        }
      ]
    }
    """.data(using: .utf8)!

    let dto = try decoder.decode(AvailableDeliveriesResponseDTO.self, from: json)
    XCTAssertEqual(dto.deliveries.count, 1)

    let domain = try XCTUnwrap(dto.deliveries[0].toDomain())
    XCTAssertEqual(domain.shortCode, "7Q4K")
    XCTAssertEqual(domain.pickupName, "Bloom Dispensary")
    // Wire is { lat, lng }; the domain Coordinate must not swap the axes.
    XCTAssertEqual(domain.pickup.latitude, 44.9778, accuracy: 0.0001)
    XCTAssertEqual(domain.pickup.longitude, -93.2650, accuracy: 0.0001)
    XCTAssertEqual(domain.dropoff.latitude, 44.9836, accuracy: 0.0001)
    XCTAssertEqual(domain.dropoff.longitude, -93.2766, accuracy: 0.0001)
    XCTAssertEqual(domain.tipCents, 650)
    XCTAssertEqual(domain.totalCents, 8_240)
    XCTAssertEqual(domain.distanceMeters, 2_100.5, accuracy: 0.001)
    XCTAssertNotNil(domain.awaitingDriverAt)
  }

  func test_toDomain_returnsNilOnMalformedOrderId() throws {
    let json = """
    {
      "orderId": "not-a-uuid",
      "shortCode": "BAD1",
      "dispensaryId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0D00",
      "pickupName": "Bloom Dispensary",
      "pickup": { "lat": 44.9778, "lng": -93.2650 },
      "dropoff": { "lat": 44.9836, "lng": -93.2766 },
      "tipCents": 650,
      "totalCents": 8240,
      "distanceMeters": 2100.5,
      "awaitingDriverAt": null
    }
    """.data(using: .utf8)!

    let dto = try decoder.decode(AvailableDeliveryDTO.self, from: json)
    XCTAssertNil(dto.toDomain(), "a malformed order id drops the row rather than crashing the board")
  }

  func test_toDomain_toleratesMissingAwaitingDriverAt() throws {
    let json = """
    {
      "orderId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0400",
      "shortCode": "7Q4K",
      "dispensaryId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0D00",
      "pickupName": "Bloom Dispensary",
      "pickup": { "lat": 44.9778, "lng": -93.2650 },
      "dropoff": { "lat": 44.9836, "lng": -93.2766 },
      "tipCents": 650,
      "totalCents": 8240,
      "distanceMeters": 2100.5,
      "awaitingDriverAt": null
    }
    """.data(using: .utf8)!

    let dto = try decoder.decode(AvailableDeliveryDTO.self, from: json)
    let domain = try XCTUnwrap(dto.toDomain())
    XCTAssertNil(domain.awaitingDriverAt)
  }

  func test_claimResponse_decodes() throws {
    let json = """
    { "orderId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0400", "status": "driver_assigned" }
    """.data(using: .utf8)!

    let dto = try decoder.decode(ClaimDeliveryResponseDTO.self, from: json)
    XCTAssertEqual(dto.orderId, "0190B7A4-9C00-72F5-A6B0-1C6F77CE0400")
    XCTAssertEqual(dto.status, "driver_assigned")
  }
}
