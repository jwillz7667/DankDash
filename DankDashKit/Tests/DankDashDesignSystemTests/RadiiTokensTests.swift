import XCTest
@testable import DankDashDesignSystem

final class RadiiTokensTests: XCTestCase {
  func test_radiiMatchSpec() {
    XCTAssertEqual(DankRadius.sm, 6)
    XCTAssertEqual(DankRadius.md, 12)
    XCTAssertEqual(DankRadius.lg, 20)
    XCTAssertEqual(DankRadius.pill, 999)
  }

  func test_inventoryIsExhaustive() {
    let names = DankRadius.allTokens.map(\.name)
    XCTAssertEqual(Set(names), Set(["sm", "md", "lg", "pill"]))
  }

  func test_pillExceedsExpectedControlHeights() {
    // Pill must exceed even the largest button (60pt) so corners stay oval.
    XCTAssertGreaterThan(DankRadius.pill, 100)
  }

  func test_scaleIsMonotonicallyIncreasing() {
    let values = DankRadius.allTokens.map(\.value)
    XCTAssertEqual(values, values.sorted())
  }
}
