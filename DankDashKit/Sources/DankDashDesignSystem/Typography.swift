import SwiftUI

/// Typographic scale. Uses the iOS system font family with semantic
/// weights — DankDash doesn't ship custom fonts in Phase 16. The scale
/// matches the spec's "Display / Title / Headline / Body / Caption /
/// Mono" naming so designers and engineers can speak the same language.
public enum DankFont {
  /// Hero rendering — only used once per screen, usually for the brand
  /// mark or a focal headline.
  public static let display: Font = .system(size: 34, weight: .bold, design: .rounded)

  /// Screen-level title (e.g. "Sign in to DankDash").
  public static let title: Font = .system(size: 28, weight: .semibold, design: .rounded)

  /// Section header / card title.
  public static let headline: Font = .system(size: 20, weight: .semibold)

  /// Default body copy.
  public static let body: Font = .system(size: 17, weight: .regular)

  /// Slightly smaller body for dense layouts (cart line items, etc.).
  public static let bodySmall: Font = .system(size: 15, weight: .regular)

  /// Microcopy: form helper text, badge labels, version strings.
  public static let caption: Font = .system(size: 13, weight: .medium)

  /// Numeric / code display. Used in the order short-code (`DD-A4F2-19`).
  public static let mono: Font = .system(size: 15, weight: .medium, design: .monospaced)
}

/// Concrete token description for equality testing — Font values aren't
/// directly comparable, so we describe them with a stable struct.
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
