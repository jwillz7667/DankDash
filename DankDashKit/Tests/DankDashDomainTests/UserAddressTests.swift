import XCTest
@testable import DankDashDomain

final class UserAddressTests: XCTestCase {
  private func makeAddress(line2: String?) -> UserAddress {
    UserAddress(
      id: UUID(),
      label: "Home",
      line1: "100 Main St",
      line2: line2,
      city: "Minneapolis",
      region: "MN",
      postalCode: "55401",
      country: "US",
      location: Coordinate(latitude: 44.98, longitude: -93.26),
      isDefault: true,
      isValidated: true,
      validatedAt: Date(timeIntervalSince1970: 0),
      deliveryInstructions: nil,
      createdAt: Date(timeIntervalSince1970: 0),
      updatedAt: Date(timeIntervalSince1970: 0)
    )
  }

  func test_oneLineWithBothStreetLines() {
    let address = makeAddress(line2: "Apt 4")
    XCTAssertEqual(address.oneLine, "100 Main St, Apt 4, Minneapolis, MN 55401")
  }

  func test_oneLineSkipsNilLine2() {
    let address = makeAddress(line2: nil)
    XCTAssertEqual(address.oneLine, "100 Main St, Minneapolis, MN 55401")
  }

  func test_oneLineSkipsWhitespaceOnlyLine2() {
    let address = makeAddress(line2: "   ")
    XCTAssertEqual(address.oneLine, "100 Main St, Minneapolis, MN 55401")
  }
}
