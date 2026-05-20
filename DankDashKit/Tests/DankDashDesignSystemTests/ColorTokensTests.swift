import XCTest
@testable import DankDashDesignSystem

final class ColorTokensTests: XCTestCase {
  func test_primaryMatchesSpec() {
    XCTAssertEqual(
      DankColor.allTokens.first { $0.name == "primary" }?.hex,
      0x1A4314
    )
  }

  func test_primaryDarkMatchesSpec() {
    XCTAssertEqual(
      DankColor.allTokens.first { $0.name == "primaryDark" }?.hex,
      0x0E2A0B
    )
  }

  func test_creamMatchesSpec() {
    XCTAssertEqual(
      DankColor.allTokens.first { $0.name == "cream" }?.hex,
      0xF5EFE0
    )
  }

  func test_accentMatchesSpec() {
    XCTAssertEqual(
      DankColor.allTokens.first { $0.name == "accent" }?.hex,
      0xC9A961
    )
  }

  func test_semanticToneInventoryIsExhaustive() {
    let semanticNames = DankColor.allTokens
      .filter { $0.name.hasPrefix("semantic.") }
      .map(\.name)
    XCTAssertEqual(
      Set(semanticNames),
      Set(["semantic.success", "semantic.warning", "semantic.danger", "semantic.info"])
    )
  }

  func test_textToneInventoryIsExhaustive() {
    let textNames = DankColor.allTokens
      .filter { $0.name.hasPrefix("text.") }
      .map(\.name)
    XCTAssertEqual(
      Set(textNames),
      Set(["text.primary", "text.secondary", "text.muted", "text.onPrimary"])
    )
  }

  func test_tokenNamesAreUnique() {
    let names = DankColor.allTokens.map(\.name)
    XCTAssertEqual(Set(names).count, names.count)
  }
}
