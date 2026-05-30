import SwiftUI

/// Brand color palette per `docs/spec/DankDash-Technical-Spec.md` §5.1.
/// The hex literals here are the single source of truth — never duplicate
/// a brand color anywhere else. If a new tone is needed, add it here.
public enum DankColor {
  /// Moss primary — bg-tinted dark green, used for primary buttons, focal
  /// surfaces, and the brand mark.
  public static let primary = Color(hex: 0x1A4314)

  /// Deeper moss for hover/active states and dark-mode backgrounds.
  public static let primaryDark = Color(hex: 0x0E2A0B)

  /// Warm cream — primary surface tint in light mode; replaces the
  /// stock white SwiftUI background everywhere DankCard renders.
  public static let cream = Color(hex: 0xF5EFE0)

  /// Antique gold — accent / call-to-action highlight. Used sparingly:
  /// destructive confirmations, "verified" badges, premium tier marks.
  public static let accent = Color(hex: 0xC9A961)

  /// Frosted-glass overlay (white @ 8% opacity). Applied on top of any
  /// surface that needs the spec's "frosted dispensary card" look.
  public static let glass = Color.white.opacity(0.08)

  /// Status / semantic tones — wired into `DankBadge` and validation
  /// states on `DankInput`. Hex values picked for AA contrast on cream.
  public enum Semantic {
    public static let success = Color(hex: 0x2E7D32)
    public static let warning = Color(hex: 0xB07A12)
    public static let danger = Color(hex: 0xB3261E)
    public static let info = Color(hex: 0x1F4E8C)
  }

  /// Text tones tuned for the cream background.
  public enum Text {
    public static let primary = Color(hex: 0x0E2A0B)
    public static let secondary = Color(hex: 0x4A5A4A)
    public static let muted = Color(hex: 0x7A8A7A)
    public static let onPrimary = Color(hex: 0xF5EFE0)
  }
}

extension Color {
  /// 24-bit RGB hex literal. Alpha is fixed at 1.0; use `.opacity()` for
  /// translucency. Constructing `Color(red:green:blue:)` from `Double`
  /// is what every brand-color library boils down to anyway — this just
  /// makes the call sites readable.
  init(hex: UInt32) {
    let r = Double((hex >> 16) & 0xFF) / 255
    let g = Double((hex >> 8) & 0xFF) / 255
    let b = Double(hex & 0xFF) / 255
    self.init(.sRGB, red: r, green: g, blue: b, opacity: 1)
  }
}

/// Token-level color description used for snapshot/equality testing
/// without depending on platform Color rendering equality.
public struct DankColorToken: Hashable, Sendable {
  public let name: String
  public let hex: UInt32

  public init(name: String, hex: UInt32) {
    self.name = name
    self.hex = hex
  }
}

public extension DankColor {
  /// Inventory of every named brand token, useful for the design gallery
  /// and for regression tests that catch accidental hex edits.
  static let allTokens: [DankColorToken] = [
    .init(name: "primary", hex: 0x1A4314),
    .init(name: "primaryDark", hex: 0x0E2A0B),
    .init(name: "cream", hex: 0xF5EFE0),
    .init(name: "accent", hex: 0xC9A961),
    .init(name: "semantic.success", hex: 0x2E7D32),
    .init(name: "semantic.warning", hex: 0xB07A12),
    .init(name: "semantic.danger", hex: 0xB3261E),
    .init(name: "semantic.info", hex: 0x1F4E8C),
    .init(name: "text.primary", hex: 0x0E2A0B),
    .init(name: "text.secondary", hex: 0x4A5A4A),
    .init(name: "text.muted", hex: 0x7A8A7A),
    .init(name: "text.onPrimary", hex: 0xF5EFE0),
  ]
}
