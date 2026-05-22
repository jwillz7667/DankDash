import XCTest
@testable import DankDashDesignSystem

final class TypographyTokensTests: XCTestCase {
  func test_displayMatchesSpec() {
    let token = DankFont.allTokens.first { $0.name == "display" }
    XCTAssertEqual(token?.size, 34)
    XCTAssertEqual(token?.weight, "bold")
  }

  func test_titleMatchesSpec() {
    let token = DankFont.allTokens.first { $0.name == "title" }
    XCTAssertEqual(token?.size, 28)
    XCTAssertEqual(token?.weight, "semibold")
  }

  func test_bodyMatchesSpec() {
    let token = DankFont.allTokens.first { $0.name == "body" }
    XCTAssertEqual(token?.size, 17)
    XCTAssertEqual(token?.weight, "regular")
  }

  func test_inventoryIsExhaustive() {
    let names = DankFont.allTokens.map(\.name)
    XCTAssertEqual(
      Set(names),
      Set(["display", "title", "headline", "body", "bodySmall", "caption", "mono"])
    )
  }

  func test_tokenNamesAreUnique() {
    let names = DankFont.allTokens.map(\.name)
    XCTAssertEqual(Set(names).count, names.count)
  }

  func test_sizeLadderIsMonotonicAndPositive() {
    for token in DankFont.allTokens {
      XCTAssertGreaterThan(token.size, 0, "\(token.name) must be positive")
    }
  }
}
