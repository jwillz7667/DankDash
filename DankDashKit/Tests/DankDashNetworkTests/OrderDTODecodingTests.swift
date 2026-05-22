import XCTest
import DankDashDomain
@testable import DankDashNetwork

final class OrderDTODecodingTests: XCTestCase {
  private let decoder = JSONDecoder()

  // MARK: - OrderResponseDTO

  func test_orderResponse_decodesAndProjectsToDomain() throws {
    let dto = try decoder.decode(OrderResponseDTO.self, from: Self.orderJSON.data(using: .utf8)!)
    let domain = try XCTUnwrap(dto.toDomain())

    XCTAssertEqual(domain.id, UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0400"))
    XCTAssertEqual(domain.shortCode, "DD-A1B2C")
    XCTAssertEqual(domain.status, .placed)
    XCTAssertEqual(domain.subtotalCents, 8_400)
    XCTAssertEqual(domain.totalCents, 9_950)
    XCTAssertEqual(domain.items.count, 1)
    XCTAssertEqual(domain.items.first?.thcMgTotal, Decimal(string: "100.0"))
  }

  func test_orderResponse_refusesWholeOrder_ifItemMalformed() throws {
    let bad = Self.orderJSON.replacingOccurrences(
      of: "\"thcMgTotal\": \"100.0\"",
      with: "\"thcMgTotal\": \"not-a-number\""
    )
    let dto = try decoder.decode(OrderResponseDTO.self, from: bad.data(using: .utf8)!)
    XCTAssertNil(
      dto.toDomain(),
      "the order is the system of record for what the user paid; one bad item line must refuse the whole projection"
    )
  }

  func test_orderResponse_returnsNilOnUnknownStatus() throws {
    let bad = Self.orderJSON.replacingOccurrences(
      of: "\"status\": \"placed\"",
      with: "\"status\": \"floating_in_limbo\""
    )
    let dto = try decoder.decode(OrderResponseDTO.self, from: bad.data(using: .utf8)!)
    XCTAssertNil(dto.toDomain())
  }

  // MARK: - OrderEventResponseDTO

  func test_eventDTO_decodesPayloadAsAnyValue() throws {
    let json = """
    {
      "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0601",
      "orderId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0400",
      "eventType": "status_changed",
      "actorUserId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0020",
      "actorRole": "system",
      "payload": { "from": "placed", "to": "accepted" },
      "occurredAt": "2026-05-20T13:11:00.000Z"
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(OrderEventResponseDTO.self, from: json)
    let domain = try XCTUnwrap(dto.toDomain())
    XCTAssertEqual(domain.eventType, "status_changed")
    XCTAssertEqual(domain.actorRole, "system")
    XCTAssertEqual(domain.payload.object?["from"]?.string, "placed")
    XCTAssertEqual(domain.payload.object?["to"]?.string, "accepted")
  }

  func test_eventDTO_allowsNullActor() throws {
    let json = """
    {
      "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0601",
      "orderId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0400",
      "eventType": "auto_transition",
      "actorUserId": null,
      "actorRole": null,
      "payload": {},
      "occurredAt": "2026-05-20T13:11:00.000Z"
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(OrderEventResponseDTO.self, from: json)
    let domain = try XCTUnwrap(dto.toDomain())
    XCTAssertNil(domain.actorUserId)
    XCTAssertNil(domain.actorRole)
  }

  // MARK: - OrderDetailResponseDTO

  func test_orderDetail_dropsMalformedEventsButKeepsOrder() throws {
    let json = """
    {
      "order": \(Self.orderJSON),
      "events": [
        {
          "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0601",
          "orderId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0400",
          "eventType": "status_changed",
          "actorUserId": null,
          "actorRole": "system",
          "payload": {},
          "occurredAt": "2026-05-20T13:11:00.000Z"
        },
        {
          "id": "not-a-uuid",
          "orderId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0400",
          "eventType": "status_changed",
          "actorUserId": null,
          "actorRole": "system",
          "payload": {},
          "occurredAt": "2026-05-20T13:12:00.000Z"
        }
      ],
      "driver": null
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(OrderDetailResponseDTO.self, from: json)
    let domain = try XCTUnwrap(dto.toDomain())
    XCTAssertEqual(
      domain.events.count,
      1,
      "events compactMap drops one bad row rather than black-holing the whole tracking screen"
    )
    XCTAssertNil(domain.driver)
  }

  func test_orderDetail_returnsNilIfOrderProjectionFails() throws {
    let json = """
    {
      "order": \(Self.orderJSON.replacingOccurrences(of: "\"status\": \"placed\"", with: "\"status\": \"unknown\"")),
      "events": [],
      "driver": null
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(OrderDetailResponseDTO.self, from: json)
    XCTAssertNil(
      dto.toDomain(),
      "the whole tracking screen depends on a valid order; bad-status order refuses the projection"
    )
  }

  func test_orderDetail_decodesDriver() throws {
    let json = """
    {
      "order": \(Self.orderJSON),
      "events": [],
      "driver": {
        "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0500",
        "displayName": "Alex P.",
        "avatarKey": null,
        "vehicleSummary": "Silver Civic",
        "maskedPhone": "+1•••-•••-1212"
      }
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(OrderDetailResponseDTO.self, from: json)
    let domain = try XCTUnwrap(dto.toDomain())
    XCTAssertEqual(domain.driver?.displayName, "Alex P.")
  }

  // MARK: - OrderListResponseDTO

  func test_orderList_decodesAndProjectsItems() throws {
    let json = """
    {
      "items": [
        {
          "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0400",
          "shortCode": "DD-A1B2C",
          "dispensaryId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0001",
          "status": "en_route_dropoff",
          "totalCents": 9950,
          "placedAt": "2026-05-20T13:10:00.000Z",
          "statusChangedAt": "2026-05-20T13:30:00.000Z"
        },
        {
          "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0401",
          "shortCode": "DD-Z9Y8X",
          "dispensaryId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0001",
          "status": "delivered",
          "totalCents": 5400,
          "placedAt": "2026-05-15T13:10:00.000Z",
          "statusChangedAt": "2026-05-15T13:45:00.000Z"
        }
      ],
      "nextCursor": "eyJjdXJzb3IiOiJuZXh0In0"
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(OrderListResponseDTO.self, from: json)
    let domain = dto.toDomain()
    XCTAssertEqual(domain.items.count, 2)
    XCTAssertEqual(domain.items.first?.status, .enRouteDropoff)
    XCTAssertEqual(domain.items.last?.status, .delivered)
    XCTAssertEqual(domain.nextCursor, "eyJjdXJzb3IiOiJuZXh0In0")
  }

  func test_orderList_silentlyDropsMalformedRows() throws {
    let json = """
    {
      "items": [
        {
          "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0400",
          "shortCode": "DD-A1B2C",
          "dispensaryId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0001",
          "status": "placed",
          "totalCents": 9950,
          "placedAt": "2026-05-20T13:10:00.000Z",
          "statusChangedAt": "2026-05-20T13:10:00.000Z"
        },
        {
          "id": "not-a-uuid",
          "shortCode": "DD-BAD",
          "dispensaryId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0001",
          "status": "placed",
          "totalCents": 100,
          "placedAt": "2026-05-20T13:10:00.000Z",
          "statusChangedAt": "2026-05-20T13:10:00.000Z"
        }
      ],
      "nextCursor": null
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(OrderListResponseDTO.self, from: json)
    let domain = dto.toDomain()
    XCTAssertEqual(
      domain.items.count,
      1,
      "list rows compactMap so one bad row doesn't black-hole the Orders tab"
    )
    XCTAssertNil(domain.nextCursor)
  }

  // MARK: - Fixtures

  private static let orderJSON = """
  {
    "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0400",
    "shortCode": "DD-A1B2C",
    "userId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0020",
    "dispensaryId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0001",
    "deliveryAddressId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0030",
    "status": "placed",
    "subtotalCents": 8400,
    "cannabisTaxCents": 850,
    "salesTaxCents": 200,
    "deliveryFeeCents": 500,
    "driverTipCents": 0,
    "discountCents": 0,
    "totalCents": 9950,
    "items": [
      {
        "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0501",
        "listingId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0101",
        "productSnapshot": { "name": "Lemon Cherry Gelato 3.5g", "brand": "Test Brand", "imageKey": "p/lcg.jpg" },
        "quantity": 1,
        "unitPriceCents": 3500,
        "lineSubtotalCents": 3500,
        "thcMgTotal": "100.0",
        "cbdMgTotal": "0",
        "weightGramsTotal": "3.5",
        "cannabisTaxCents": 350,
        "salesTaxCents": 80,
        "createdAt": "2026-05-20T13:10:00.000Z"
      }
    ],
    "placedAt": "2026-05-20T13:10:00.000Z",
    "statusChangedAt": "2026-05-20T13:10:00.000Z",
    "createdAt": "2026-05-20T13:10:00.000Z",
    "updatedAt": "2026-05-20T13:10:00.000Z"
  }
  """
}
