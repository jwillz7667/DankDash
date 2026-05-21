import XCTest
@testable import DankDashDomain

final class DriverPublicProfileTests: XCTestCase {
  private func makeProfile(displayName: String) -> DriverPublicProfile {
    DriverPublicProfile(
      id: UUID(),
      displayName: displayName,
      avatarKey: nil,
      vehicleSummary: nil,
      maskedPhone: nil
    )
  }

  func test_initialsForFirstAndLastName() {
    XCTAssertEqual(makeProfile(displayName: "Alex Patel").initials, "AP")
  }

  func test_initialsCollapsesMiddleNames() {
    XCTAssertEqual(makeProfile(displayName: "Mary Jane Watson").initials, "MW")
  }

  func test_initialsSingleTokenReturnsOneLetter() {
    XCTAssertEqual(makeProfile(displayName: "Cher").initials, "C")
  }

  func test_initialsEmptyNameReturnsEmpty() {
    XCTAssertEqual(makeProfile(displayName: "").initials, "")
  }

  func test_initialsAreUppercased() {
    XCTAssertEqual(makeProfile(displayName: "alex patel").initials, "AP")
  }
}
