import XCTest
import DankDashDomain
@testable import DankDashNetwork

final class DispensaryDTODecodingTests: XCTestCase {
  private let decoder = JSONDecoder()

  func test_dispensaryList_decodesAndProjectsToDomain() throws {
    let data = Self.listJSON.data(using: .utf8)!
    let envelope = try decoder.decode(DispensaryListResponseDTO.self, from: data)
    let domain = envelope.toDomain()

    XCTAssertEqual(domain.count, 1)
    let store = try XCTUnwrap(domain.first)
    XCTAssertEqual(store.id, UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0001"))
    XCTAssertEqual(store.legalName, "Nokomis Cannabis Co.")
    XCTAssertEqual(store.dba, "Nokomis Co.")
    XCTAssertEqual(store.licenseType, .retailer)
    XCTAssertEqual(store.region, "MN")
    XCTAssertEqual(store.location.latitude, 44.9778, accuracy: 0.0001)
    XCTAssertEqual(store.location.longitude, -93.2650, accuracy: 0.0001)
    XCTAssertEqual(store.deliveryPolygon.outerRing.count, 5)
    XCTAssertEqual(store.ratingAvg, Decimal(string: "4.65"))
    XCTAssertEqual(store.ratingCount, 47)
    XCTAssertTrue(store.isAcceptingOrders)
    XCTAssertTrue(store.isOpenNow)
    XCTAssertEqual(store.status, .active)
    XCTAssertEqual(store.hours.mon?.openMinutes, 8 * 60)
    XCTAssertEqual(store.hours.fri?.closeMinutes, 26 * 60)
    XCTAssertNil(store.hours.sun)
  }

  func test_dispensary_dropsMalformedRowsRatherThanFailingTheEnvelope() throws {
    let json = """
    {
      "dispensaries": [
        \(Self.singleDispensaryJSON),
        {
          "id": "not-a-uuid",
          "legalName": "Bogus",
          "dba": null,
          "licenseNumber": "X",
          "licenseType": "retailer",
          "addressLine1": "1",
          "addressLine2": null,
          "city": "Y",
          "region": "MN",
          "postalCode": "00000",
          "location": { "type": "Point", "coordinates": [0, 0] },
          "deliveryPolygon": { "type": "Polygon", "coordinates": [[[0,0],[1,0],[1,1],[0,1],[0,0]]] },
          "hours": { "mon": null, "tue": null, "wed": null, "thu": null, "fri": null, "sat": null, "sun": null },
          "phone": null,
          "email": null,
          "logoImageKey": null,
          "heroImageKey": null,
          "brandColorHex": null,
          "isAcceptingOrders": true,
          "isOpenNow": false,
          "opensAt": null,
          "ratingAvg": null,
          "ratingCount": 0,
          "status": "active",
          "createdAt": "2026-01-01T00:00:00.000Z",
          "updatedAt": "2026-01-01T00:00:00.000Z"
        }
      ]
    }
    """.data(using: .utf8)!

    let envelope = try decoder.decode(DispensaryListResponseDTO.self, from: json)
    let domain = envelope.toDomain()
    XCTAssertEqual(domain.count, 1, "malformed row should be silently dropped")
  }

  func test_geoPoint_rejectsWrongDiscriminator() {
    let dto = GeoPointDTO(type: "Polygon", coordinates: [0, 0])
    XCTAssertNil(dto.asCoordinate)
  }

  func test_geoPoint_rejectsWrongDimensionality() {
    let dto = GeoPointDTO(type: "Point", coordinates: [0])
    XCTAssertNil(dto.asCoordinate)
  }

  func test_dispensary_rejectsMalformedPolygon() throws {
    let badPoint = """
    \(Self.singleDispensaryJSON.replacingOccurrences(
      of: "\"deliveryPolygon\": { \"type\": \"Polygon\", \"coordinates\": [[[-93.27,44.97],[-93.27,44.98],[-93.26,44.98],[-93.26,44.97],[-93.27,44.97]]] }",
      with: "\"deliveryPolygon\": { \"type\": \"Polygon\", \"coordinates\": [[[-93.27]]] }"
    ))
    """
    let dto = try decoder.decode(DispensaryDTO.self, from: badPoint.data(using: .utf8)!)
    XCTAssertNil(dto.toDomain())
  }

  func test_dispensary_rejectsUnknownLicenseType() throws {
    let bad = Self.singleDispensaryJSON.replacingOccurrences(
      of: "\"licenseType\": \"retailer\"",
      with: "\"licenseType\": \"unicorn\""
    )
    let dto = try decoder.decode(DispensaryDTO.self, from: bad.data(using: .utf8)!)
    XCTAssertNil(dto.toDomain())
  }

  func test_dispensary_rejectsMalformedHoursHHMM() throws {
    let bad = Self.singleDispensaryJSON.replacingOccurrences(
      of: "\"mon\": { \"open\": \"08:00\", \"close\": \"22:00\" }",
      with: "\"mon\": { \"open\": \"08:00\", \"close\": \"99:99\" }"
    )
    let dto = try decoder.decode(DispensaryDTO.self, from: bad.data(using: .utf8)!)
    XCTAssertNil(dto.toDomain())
  }

  // MARK: - Fixtures (pinned representative response)

  private static let singleDispensaryJSON = """
  {
    "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0001",
    "legalName": "Nokomis Cannabis Co.",
    "dba": "Nokomis Co.",
    "licenseNumber": "MN-RET-0001",
    "licenseType": "retailer",
    "addressLine1": "1100 Hennepin Ave",
    "addressLine2": "Suite 204",
    "city": "Minneapolis",
    "region": "MN",
    "postalCode": "55403",
    "location": { "type": "Point", "coordinates": [-93.2650, 44.9778] },
    "deliveryPolygon": { "type": "Polygon", "coordinates": [[[-93.27,44.97],[-93.27,44.98],[-93.26,44.98],[-93.26,44.97],[-93.27,44.97]]] },
    "hours": {
      "mon": { "open": "08:00", "close": "22:00" },
      "tue": { "open": "08:00", "close": "22:00" },
      "wed": { "open": "08:00", "close": "22:00" },
      "thu": { "open": "08:00", "close": "22:00" },
      "fri": { "open": "08:00", "close": "26:00" },
      "sat": { "open": "10:00", "close": "26:00" },
      "sun": null
    },
    "phone": "+16125551212",
    "email": "support@nokomis.test",
    "logoImageKey": "stores/nokomis-logo.png",
    "heroImageKey": "stores/nokomis-hero.jpg",
    "brandColorHex": "#1E8E3E",
    "isAcceptingOrders": true,
    "isOpenNow": true,
    "opensAt": null,
    "ratingAvg": "4.65",
    "ratingCount": 47,
    "status": "active",
    "createdAt": "2026-01-10T12:00:00.000Z",
    "updatedAt": "2026-05-15T08:30:00.000Z"
  }
  """

  private static let listJSON = "{ \"dispensaries\": [\(singleDispensaryJSON)] }"
}
