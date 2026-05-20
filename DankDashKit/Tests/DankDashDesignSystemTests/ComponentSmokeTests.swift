import XCTest
import SwiftUI
@testable import DankDashDesignSystem

/// Smoke tests that exercise the component initializers. They do not
/// render pixels — that requires UIKit and an iOS host. The goal here is
/// to catch initializer-signature regressions and confirm every public
/// variant compiles and instantiates without trapping. The class is
/// MainActor-isolated because SwiftUI views are.
@MainActor
final class ComponentSmokeTests: XCTestCase {
  func test_dankButton_allStyleSizeCombinations() {
    let styles: [DankButton.Style] = [.primary, .secondary, .ghost, .destructive]
    let sizes: [DankButton.Size] = [.small, .medium, .large]
    for style in styles {
      for size in sizes {
        let button = DankButton("Tap", style: style, size: size) {}
        XCTAssertNotNil(button.body)
      }
    }
  }

  func test_dankButton_loadingAndDisabled() {
    XCTAssertNotNil(DankButton("Submit", isLoading: true) {}.body)
    XCTAssertNotNil(DankButton("Locked", isDisabled: true) {}.body)
  }

  func test_dankButtonSizes_heightLadderIsMonotonic() {
    let heights = [DankButton.Size.small, .medium, .large].map(\.height)
    XCTAssertEqual(heights, heights.sorted())
    XCTAssertGreaterThan(DankButton.Size.small.height, 0)
  }

  func test_dankCard_solidAndFrosted() {
    let solid = DankCard(style: .solid) { Text("hi") }
    let frosted = DankCard(style: .frosted) { Text("hi") }
    XCTAssertNotNil(solid.body)
    XCTAssertNotNil(frosted.body)
  }

  func test_dankCard_extensionModifier() {
    let view = Text("Hello").dankCard()
    XCTAssertNotNil(view.body)
  }

  func test_dankInput_kindsAndValidationStates() {
    let kinds: [DankInput.Kind] = [.text, .secure, .email, .phone]
    let states: [DankInput.ValidationState] = [.idle, .valid, .invalid("bad")]
    for kind in kinds {
      for state in states {
        let input = DankInput(
          label: "Email",
          text: .constant(""),
          kind: kind,
          validation: state
        )
        XCTAssertNotNil(input.body)
      }
    }
  }

  func test_dankBadge_allTones() {
    for tone in DankBadge.Tone.allCases {
      let badge = DankBadge("Live", tone: tone)
      XCTAssertNotNil(badge.body)
    }
  }

  func test_dankLogo_allVariants() {
    for variant in DankLogo.Variant.allCases {
      let logo = DankLogo(variant)
      XCTAssertNotNil(logo.body)
    }
  }

  func test_dankLoader_allSizes() {
    let sizes: [DankLoader.Size] = [.small, .medium, .large]
    for size in sizes {
      XCTAssertGreaterThan(size.dimension, 0)
      let loader = DankLoader(size: size)
      XCTAssertNotNil(loader.body)
    }
  }

  func test_dankLoader_sizeLadderIsMonotonic() {
    let dimensions = [DankLoader.Size.small, .medium, .large].map(\.dimension)
    XCTAssertEqual(dimensions, dimensions.sorted())
  }
}
