import XCTest
@testable import DankDashDesignSystem

final class ColorTokensTests: XCTestCase {
  func test_primaryMatchesSpec() {
    XCTAssertEqual(
      DankColor.allTokens.first { $0.name == "primary" }?.hex,
      0x3B9322
    )
  }

  func test_primaryDarkMatchesSpec() {
    XCTAssertEqual(
      DankColor.allTokens.first { $0.name == "primaryDark" }?.hex,
      0x256014
    )
  }

  func test_creamIsWhiteAfterRebrand() {
    XCTAssertEqual(
      DankColor.allTokens.first { $0.name == "cream" }?.hex,
      0xFFFFFF
    )
  }

  func test_backgroundAliasesCream() {
    let cream = DankColor.allTokens.first { $0.name == "cream" }?.hex
    let background = DankColor.allTokens.first { $0.name == "background" }?.hex
    XCTAssertEqual(cream, background)
    XCTAssertEqual(background, 0xFFFFFF)
  }

  func test_accentAliasesPrimary() {
    let primary = DankColor.allTokens.first { $0.name == "primary" }?.hex
    let accent = DankColor.allTokens.first { $0.name == "accent" }?.hex
    XCTAssertEqual(primary, accent)
    XCTAssertEqual(accent, 0x3B9322)
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
      Set([
        "text.primary",
        "text.secondary",
        "text.muted",
        "text.onPrimary",
        "text.onBackground",
      ])
    )
  }

  func test_onPrimaryIsPureWhite() {
    XCTAssertEqual(
      DankColor.allTokens.first { $0.name == "text.onPrimary" }?.hex,
      0xFFFFFF
    )
  }

  func test_onBackgroundReadsAsDarkForAAAContrast() {
    XCTAssertEqual(
      DankColor.allTokens.first { $0.name == "text.onBackground" }?.hex,
      0x0F1A0D
    )
  }

  func test_tokenNamesAreUnique() {
    let names = DankColor.allTokens.map(\.name)
    XCTAssertEqual(Set(names).count, names.count)
  }
}
