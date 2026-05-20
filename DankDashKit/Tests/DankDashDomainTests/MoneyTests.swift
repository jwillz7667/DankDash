import XCTest
@testable import DankDashDomain

final class MoneyTests: XCTestCase {
  func test_storesIntegerCents() {
    XCTAssertEqual(Money(cents: 1234).cents, 1234)
    XCTAssertEqual(Money(cents: 0), .zero)
  }

  func test_dollarsAsDecimal() {
    XCTAssertEqual(Money(cents: 1234).dollars, Decimal(string: "12.34"))
    XCTAssertEqual(Money(cents: 1).dollars, Decimal(string: "0.01"))
    XCTAssertEqual(Money(cents: 0).dollars, 0)
  }

  func test_addition() {
    XCTAssertEqual(Money(cents: 100) + Money(cents: 250), Money(cents: 350))
  }

  func test_subtraction() {
    XCTAssertEqual(Money(cents: 500) - Money(cents: 199), Money(cents: 301))
  }

  func test_multiplyByQuantity() {
    XCTAssertEqual(Money(cents: 1599) * 3, Money(cents: 4797))
  }

  func test_orderable() {
    XCTAssertLessThan(Money(cents: 100), Money(cents: 200))
    XCTAssertGreaterThan(Money(cents: 500), Money(cents: 499))
  }

  func test_formattedUSD() {
    XCTAssertEqual(Money(cents: 1234).formatted(), "$12.34")
    XCTAssertEqual(Money(cents: 50).formatted(), "$0.50")
    XCTAssertEqual(Money(cents: 0).formatted(), "$0.00")
  }

  func test_codableEmitsInteger() throws {
    let m = Money(cents: 4500)
    let data = try JSONEncoder().encode(m)
    XCTAssertEqual(String(data: data, encoding: .utf8), "4500")
    let back = try JSONDecoder().decode(Money.self, from: data)
    XCTAssertEqual(back, m)
  }
}
