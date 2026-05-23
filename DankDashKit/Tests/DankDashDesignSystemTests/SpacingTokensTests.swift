import XCTest
@testable import DankDashDesignSystem

final class SpacingTokensTests: XCTestCase {
  func test_baseUnitsMatchFourPointLadder() {
    XCTAssertEqual(DankSpacing.xxs, 4)
    XCTAssertEqual(DankSpacing.xs, 8)
    XCTAssertEqual(DankSpacing.sm, 12)
    XCTAssertEqual(DankSpacing.md, 16)
    XCTAssertEqual(DankSpacing.lg, 24)
    XCTAssertEqual(DankSpacing.xl, 32)
    XCTAssertEqual(DankSpacing.xxl, 48)
  }

  func test_inventoryIsExhaustive() {
    let names = DankSpacing.allTokens.map(\.name)
    XCTAssertEqual(
      Set(names),
      Set(["xxs", "xs", "sm", "md", "lg", "xl", "xxl"])
    )
  }

  func test_scaleIsMonotonicallyIncreasing() {
    let values = DankSpacing.allTokens.map(\.value)
    let sorted = values.sorted()
    XCTAssertEqual(values, sorted, "spacing ladder must be ordered smallest → largest")
  }

  func test_everyTokenIsPositive() {
    for token in DankSpacing.allTokens {
      XCTAssertGreaterThan(token.value, 0, "\(token.name) must be positive")
    }
  }
}
