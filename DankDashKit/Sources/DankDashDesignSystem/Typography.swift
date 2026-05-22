import SwiftUI

/// Typographic scale. Built on SwiftUI ``Font.TextStyle`` so every token
/// scales with the user's Dynamic Type setting AND the device size class
/// (iPhone SE vs iPhone 16 Pro Max). The token sizes below describe the
/// *default* point size at `.large` Dynamic Type — the rendered font will
/// scale up or down from there.
///
/// Apps that want to cap the upper-bound scaling (so accessibility-XXXL
/// doesn't blow up a fixed-height card) should apply
/// ``View/dynamicTypeSize(_:)`` near the app root.
public enum DankFont {
  /// Hero rendering — only used once per screen, usually for the brand
  /// mark or a focal headline. Default 34pt.
  public static let display: Font = .system(.largeTitle, design: .rounded, weight: .bold)

  /// Screen-level title (e.g. "Sign in to DankDash"). Default 28pt.
  public static let title: Font = .system(.title, design: .rounded, weight: .semibold)

  /// Section header / card title. Default 20pt.
  public static let headline: Font = .system(.title3, design: .default, weight: .semibold)

  /// Default body copy. Default 17pt.
  public static let body: Font = .system(.body, design: .default, weight: .regular)

  /// Slightly smaller body for dense layouts (cart line items, etc.). Default 15pt.
  public static let bodySmall: Font = .system(.subheadline, design: .default, weight: .regular)

  /// Microcopy: form helper text, badge labels, version strings. Default 13pt.
  public static let caption: Font = .system(.footnote, design: .default, weight: .medium)

  /// Numeric / code display. Used in the order short-code (`DD-A4F2-19`). Default 15pt.
  public static let mono: Font = .system(.subheadline, design: .monospaced, weight: .medium)
}

/// Concrete token description for equality testing — Font values aren't
/// directly comparable, so we describe them with a stable struct. Sizes
/// are the *default* (.large Dynamic Type) point size for each token.
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
    .init(name: "display", size: 34, weight: "bold"),
    .init(name: "title", size: 28, weight: "semibold"),
    .init(name: "headline", size: 20, weight: "semibold"),
    .init(name: "body", size: 17, weight: "regular"),
    .init(name: "bodySmall", size: 15, weight: "regular"),
    .init(name: "caption", size: 13, weight: "medium"),
    .init(name: "mono", size: 15, weight: "medium"),
  ]
}
