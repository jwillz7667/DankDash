import XCTest
@testable import DankDashNetwork

final class CatalogWireHelpersTests: XCTestCase {
  func test_parseDecimal_acceptsServerNumericStringShapes() {
    XCTAssertEqual(CatalogWire.parseDecimal("0"), Decimal(0))
    XCTAssertEqual(CatalogWire.parseDecimal("-0"), Decimal(0))
    XCTAssertEqual(CatalogWire.parseDecimal("875"), Decimal(875))
    XCTAssertEqual(CatalogWire.parseDecimal("875.00"), Decimal(string: "875.00"))
    XCTAssertEqual(CatalogWire.parseDecimal("-12.5"), Decimal(string: "-12.5"))
    XCTAssertEqual(CatalogWire.parseDecimal("3.14159265358979323846"), Decimal(string: "3.14159265358979323846"))
  }

  func test_parseDecimal_rejectsNonNumericStringsThatFoundationWouldOtherwiseEat() {
    // Foundation's `Decimal(string:)` permissively returns 0 for "eight
    // hundred" / "abc 123" — we tighten that to nil so a malformed wire
    // value can never silently become a 0g cannabis weight.
    XCTAssertNil(CatalogWire.parseDecimal("eight hundred"))
    XCTAssertNil(CatalogWire.parseDecimal("abc 123"))
    XCTAssertNil(CatalogWire.parseDecimal(""))
    XCTAssertNil(CatalogWire.parseDecimal(" 100"))
    XCTAssertNil(CatalogWire.parseDecimal("100 "))
    XCTAssertNil(CatalogWire.parseDecimal("100,000"))
    XCTAssertNil(CatalogWire.parseDecimal("+100"))
    XCTAssertNil(CatalogWire.parseDecimal("1e10"))
    XCTAssertNil(CatalogWire.parseDecimal("NaN"))
  }

  func test_parseISO8601_acceptsFractionalAndWholeSeconds() {
    XCTAssertNotNil(CatalogWire.parseISO8601("2026-05-15T08:30:00.000Z"))
    XCTAssertNotNil(CatalogWire.parseISO8601("2026-05-15T08:30:00Z"))
    XCTAssertNotNil(CatalogWire.parseISO8601("2026-05-15T08:30:00+00:00"))
  }

  func test_parseISO8601_rejectsLooseDateOnly() {
    XCTAssertNil(CatalogWire.parseISO8601("2026-05-15"))
    XCTAssertNil(CatalogWire.parseISO8601("garbage"))
  }
}
