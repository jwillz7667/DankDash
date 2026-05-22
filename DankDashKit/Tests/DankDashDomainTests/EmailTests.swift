import XCTest
@testable import DankDashDomain

final class EmailTests: XCTestCase {
  func test_acceptsPlausibleAddresses() {
    XCTAssertNotNil(Email("user@example.com"))
    XCTAssertNotNil(Email("first.last+tag@subdomain.example.com"))
    XCTAssertNotNil(Email("a@b.co"))
    XCTAssertNotNil(Email("digit123@host123.io"))
  }

  func test_lowercasesAndTrims() {
    XCTAssertEqual(Email("  User@Example.COM  ")?.rawValue, "user@example.com")
  }

  func test_rejectsObviousFailures() {
    XCTAssertNil(Email(""))
    XCTAssertNil(Email("no-at-symbol"))
    XCTAssertNil(Email("@no-local.com"))
    XCTAssertNil(Email("no-host@"))
    XCTAssertNil(Email("no-dot@host"))
    XCTAssertNil(Email("two@@signs.com"))
    XCTAssertNil(Email("trailing-dot@host."))
    XCTAssertNil(Email("leading-dot@.host.com"))
  }

  func test_rejectsOversize() {
    let local = String(repeating: "a", count: 250)
    XCTAssertNil(Email("\(local)@b.co"))
  }

  func test_roundTripsThroughCodable() throws {
    let email = Email("hi@dankdash.test")!
    let data = try JSONEncoder().encode(email)
    let back = try JSONDecoder().decode(Email.self, from: data)
    XCTAssertEqual(back, email)
  }

  func test_decodingFailsOnInvalidInput() {
    let data = #""nope""#.data(using: .utf8)!
    XCTAssertThrowsError(try JSONDecoder().decode(Email.self, from: data))
  }
}
