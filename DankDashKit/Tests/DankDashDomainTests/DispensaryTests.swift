import XCTest
@testable import DankDashDomain

final class DispensaryTests: XCTestCase {
  private func make(legalName: String = "Sample Retail LLC", dba: String? = nil) -> Dispensary {
    Dispensary(
      id: UUID(),
      legalName: legalName,
      dba: dba,
      licenseNumber: "MN-RET-0001",
      licenseType: .retailer,
      addressLine1: "100 Main St",
      addressLine2: nil,
      city: "Minneapolis",
      region: "MN",
      postalCode: "55401",
      location: Coordinate(latitude: 44.98, longitude: -93.26),
      deliveryPolygon: GeoPolygon(rings: [[
        Coordinate(latitude: 44.97, longitude: -93.27),
        Coordinate(latitude: 44.97, longitude: -93.25),
        Coordinate(latitude: 44.99, longitude: -93.25),
        Coordinate(latitude: 44.99, longitude: -93.27),
        Coordinate(latitude: 44.97, longitude: -93.27),
      ]]),
      hours: DispensaryHours(
        mon: DayHours(open: "09:00", close: "21:00"),
        tue: DayHours(open: "09:00", close: "21:00"),
        wed: DayHours(open: "09:00", close: "21:00"),
        thu: DayHours(open: "09:00", close: "21:00"),
        fri: DayHours(open: "09:00", close: "21:00"),
        sat: DayHours(open: "09:00", close: "21:00"),
        sun: nil
      ),
      phone: nil,
      email: nil,
      logoImageKey: nil,
      heroImageKey: nil,
      brandColorHex: nil,
      isAcceptingOrders: true,
      isOpenNow: true,
      opensAt: nil,
      ratingAvg: Decimal(string: "4.50"),
      ratingCount: 100,
      status: .active,
      createdAt: Date(timeIntervalSince1970: 0),
      updatedAt: Date(timeIntervalSince1970: 0)
    )
  }

  func test_displayNamePrefersDBAWhenPresent() {
    let dispensary = make(legalName: "Sample Retail LLC", dba: "Sample Buds")
    XCTAssertEqual(dispensary.displayName, "Sample Buds")
  }

  func test_displayNameFallsBackToLegalNameWhenDBAIsNil() {
    let dispensary = make(legalName: "Sample Retail LLC", dba: nil)
    XCTAssertEqual(dispensary.displayName, "Sample Retail LLC")
  }

  func test_displayNameFallsBackToLegalNameWhenDBAIsWhitespace() {
    let dispensary = make(legalName: "Sample Retail LLC", dba: "   ")
    XCTAssertEqual(dispensary.displayName, "Sample Retail LLC")
  }
}
