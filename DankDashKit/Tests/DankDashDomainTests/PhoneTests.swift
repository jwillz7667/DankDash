import XCTest
@testable import DankDashDomain

final class PhoneTests: XCTestCase {
  func test_acceptsValidE164() {
    XCTAssertNotNil(Phone("+14155551234"))
    XCTAssertNotNil(Phone("+12025550199"))
    XCTAssertNotNil(Phone("+447911123456"))
  }

  func test_rejectsCommonShapeMistakes() {
    XCTAssertNil(Phone(""))
    XCTAssertNil(Phone("4155551234"))           // missing +
    XCTAssertNil(Phone("+04155551234"))         // leading zero after +
    XCTAssertNil(Phone("+1"))                   // too short
    XCTAssertNil(Phone("+1-415-555-1234"))      // separators
    XCTAssertNil(Phone("+1 415 555 1234"))      // spaces
    XCTAssertNil(Phone("+1234567890123456"))    // 16 digits
  }

  func test_trimsWhitespace() {
    XCTAssertEqual(Phone(" +14155551234 ")?.rawValue, "+14155551234")
  }

  func test_codableRoundTrip() throws {
    let phone = Phone("+14155551234")!
    let data = try JSONEncoder().encode(phone)
    let back = try JSONDecoder().decode(Phone.self, from: data)
    XCTAssertEqual(back, phone)
  }
}
