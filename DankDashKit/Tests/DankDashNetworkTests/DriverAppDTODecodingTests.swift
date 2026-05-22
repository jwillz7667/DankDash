import XCTest
import DankDashDomain
@testable import DankDashNetwork

/// Wire-shape pinning for the driver-app read surface — earnings,
/// current-route, and shifts. Mirrors Phase-8 `driver-app.dto.ts`.
final class DriverAppDTODecodingTests: XCTestCase {
  private let decoder = JSONDecoder()

  // MARK: - Earnings

  func test_earnings_decodesAndProjectsToDomain() throws {
    let json = """
    {
      "period": "today",
      "since": "2026-05-20T05:00:00.000Z",
      "until": "2026-05-21T05:00:00.000Z",
      "tipsCents": 4500,
      "deliveryFeesCents": 12000,
      "deliveriesCount": 7,
      "totalCents": 16500
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(EarningsResponseDTO.self, from: json)
    let domain = try XCTUnwrap(dto.toDomain())
    XCTAssertEqual(domain.period, .today)
    XCTAssertEqual(domain.tipsCents, 4_500)
    XCTAssertEqual(domain.deliveryFeesCents, 12_000)
    XCTAssertEqual(domain.deliveriesCount, 7)
    XCTAssertEqual(domain.totalCents, 16_500)
    XCTAssertEqual(domain.averagePerDeliveryCents, 2_357) // 16500 / 7 = 2357.14...
  }

  func test_earnings_refusesUnknownPeriod() throws {
    let json = """
    {
      "period": "fortnight",
      "since": "2026-05-20T05:00:00.000Z",
      "until": "2026-05-21T05:00:00.000Z",
      "tipsCents": 0,
      "deliveryFeesCents": 0,
      "deliveriesCount": 0,
      "totalCents": 0
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(EarningsResponseDTO.self, from: json)
    XCTAssertNil(dto.toDomain())
  }

  // MARK: - Current route

  func test_currentRoute_noActiveOrderProjectsToNone() throws {
    let json = """
    { "activeOrder": null }
    """.data(using: .utf8)!
    let dto = try decoder.decode(CurrentRouteResponseDTO.self, from: json)
    let domain = try XCTUnwrap(dto.toDomain())
    switch domain {
    case .none: break
    case .active: XCTFail("expected .none for null activeOrder")
    }
  }

  func test_currentRoute_activeOrderProjectsAllThreeSlices() throws {
    let dto = try decoder.decode(CurrentRouteResponseDTO.self, from: Self.activeRouteJSON.data(using: .utf8)!)
    let domain = try XCTUnwrap(dto.toDomain())
    guard case let .active(route) = domain else {
      XCTFail("expected .active for populated activeOrder")
      return
    }
    XCTAssertEqual(route.order.shortCode, "DD-A1B2C")
    XCTAssertEqual(route.pickup.name, "Northside Cannabis Co.")
    XCTAssertEqual(route.pickup.location.latitude, 44.9778)
    XCTAssertEqual(route.dropoff.line1, "123 Snelling Ave")
    XCTAssertEqual(route.dropoff.deliveryInstructions, "Gate code 0421")
  }

  func test_currentRoute_dropoffWithNullLocationStillProjects() throws {
    let json = Self.activeRouteJSON.replacingOccurrences(
      of: "\"location\": { \"type\": \"Point\", \"coordinates\": [-93.1730, 44.9484] }",
      with: "\"location\": null"
    )
    let dto = try decoder.decode(CurrentRouteResponseDTO.self, from: json.data(using: .utf8)!)
    let domain = try XCTUnwrap(dto.toDomain())
    if case let .active(route) = domain {
      XCTAssertNil(route.dropoff.location)
    } else {
      XCTFail("expected .active")
    }
  }

  // MARK: - Shifts list

  func test_shiftsList_dropsMalformedRow() throws {
    let json = """
    {
      "shifts": [
        {
          "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0A00",
          "driverId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0900",
          "startedAt": "2026-05-20T13:00:00.000Z",
          "endedAt": "2026-05-20T19:30:00.000Z",
          "startingLocation": null,
          "endingLocation": null,
          "totalMiles": "42.371",
          "totalDeliveries": 9,
          "totalEarningsCents": 18500
        },
        {
          "id": "not-a-uuid",
          "driverId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0900",
          "startedAt": "2026-05-19T13:00:00.000Z",
          "endedAt": "2026-05-19T19:30:00.000Z",
          "startingLocation": null,
          "endingLocation": null,
          "totalMiles": null,
          "totalDeliveries": 6,
          "totalEarningsCents": 12000
        }
      ]
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(ShiftsListResponseDTO.self, from: json)
    let domain = dto.toDomain()
    XCTAssertEqual(
      domain.count,
      1,
      "compactMap drops the bad-UUID row; one bad row shouldn't black-hole the history view"
    )
  }

  // MARK: - Fixture

  static let activeRouteJSON: String = """
  {
    "activeOrder": {
      "order": {
        "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0400",
        "shortCode": "DD-A1B2C",
        "userId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0500",
        "dispensaryId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0600",
        "deliveryAddressId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0700",
        "status": "accepted",
        "subtotalCents": 8400,
        "cannabisTaxCents": 850,
        "salesTaxCents": 700,
        "deliveryFeeCents": 500,
        "driverTipCents": 0,
        "discountCents": 0,
        "totalCents": 10450,
        "items": [],
        "placedAt": "2026-05-20T13:10:00.000Z",
        "statusChangedAt": "2026-05-20T13:11:00.000Z",
        "createdAt": "2026-05-20T13:10:00.000Z",
        "updatedAt": "2026-05-20T13:11:00.000Z"
      },
      "pickup": {
        "dispensaryId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0600",
        "name": "Northside Cannabis Co.",
        "addressLine1": "501 Lyndale Ave N",
        "addressLine2": null,
        "city": "Minneapolis",
        "region": "MN",
        "postalCode": "55405",
        "location": { "type": "Point", "coordinates": [-93.2650, 44.9778] },
        "phone": "+16125551234",
        "brandColorHex": "#1A4314"
      },
      "dropoff": {
        "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0700",
        "label": "Home",
        "line1": "123 Snelling Ave",
        "line2": "Apt 4",
        "city": "Saint Paul",
        "region": "MN",
        "postalCode": "55104",
        "country": "US",
        "location": { "type": "Point", "coordinates": [-93.1730, 44.9484] },
        "deliveryInstructions": "Gate code 0421"
      }
    }
  }
  """
}
