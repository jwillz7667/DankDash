import SwiftUI

/// Typographic scale. Built on SwiftUI `Font.TextStyle` so every token
/// scales with the user's Dynamic Type setting AND the device size
/// class (iPhone SE vs iPhone 16 Pro Max). Values come from
/// `packages/design-tokens/src/tokens.ts` via codegen — the default
/// point sizes below reflect what each token resolves to at `.large`
/// Dynamic Type.
///
/// Apps that want to cap the upper-bound scaling (so accessibility-XXXL
/// doesn't blow up a fixed-height card) should apply
/// ``View/dynamicTypeSize(_:)`` near the app root.
public enum DankFont {
  /// Hero rendering — once per screen, brand mark or focal headline.
  public static let display = GeneratedTokens.Typography.display

  /// Screen-level title (e.g. "Sign in to DankDash").
  public static let title = GeneratedTokens.Typography.title

  /// Section header / card title.
  public static let headline = GeneratedTokens.Typography.headline

  /// Default body copy.
  public static let body = GeneratedTokens.Typography.body

  /// Slightly smaller body for dense layouts.
  public static let bodySmall = GeneratedTokens.Typography.bodySmall

  /// Microcopy: form helper text, badge labels, version strings.
  public static let caption = GeneratedTokens.Typography.caption

  /// Numeric / code display. Used in the order short-code (`DD-A4F2-19`).
  public static let mono = GeneratedTokens.Typography.mono
}

/// Concrete token description for equality testing — Font values aren't
/// directly comparable, so we describe them with a stable struct. Sizes
/// are the *default* (.large Dynamic Type) point size for each token,
/// mirroring `tokens.typography.<name>.size`.
public struct DankFontToken: Hashable, Sendable {
  public let name: String
  public let size: Double
  public let weight: String

  public init(name: String, size: Double, weight: String) {
    self.name = name
    self.size = size
    self.weight = weight
  }
}

public extension DankFont {
  static let allTokens: [DankFontToken] = [
    DankFontToken(name: "display", size: 28, weight: "bold"),
    DankFontToken(name: "title", size: 22, weight: "semibold"),
    DankFontToken(name: "headline", size: 17, weight: "semibold"),
    DankFontToken(name: "body", size: 16, weight: "regular"),
    DankFontToken(name: "bodySmall", size: 13, weight: "regular"),
    DankFontToken(name: "caption", size: 12, weight: "medium"),
    DankFontToken(name: "mono", size: 13, weight: "medium"),
  ]
}
