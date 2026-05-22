import SwiftUI

/// Brand color palette per `docs/spec/DankDash-Technical-Spec.md` §5.1.
/// The hex literals here are the single source of truth — never duplicate
/// a brand color anywhere else. If a new tone is needed, add it here.
///
/// **2026-05 rebrand** — primary pivoted from moss `#1A4314` to bright
/// `#3B9322`, the surface neutral from cream `#F5EFE0` to pure white
/// `#FFFFFF`. Token names stayed stable (`cream`, `accent`) to avoid a
/// project-wide rename; the call sites continue to compile while the
/// rendered output picks up the new palette. `background` + `Text.onBackground`
/// are the preferred names for new surfaces.
public enum DankColor {
  /// Brand green — primary buttons, focal surfaces, the brand mark, and
  /// the in-app accent (matches `AccentColor.colorset` exactly).
  public static let primary = Color(hex: 0x3B9322)

  /// Deeper green for hover/active states and dark-mode backgrounds.
  /// Kept dark enough to stay distinct from `primary` on light surfaces.
  public static let primaryDark = Color(hex: 0x256014)

  /// Pure white surface. Name kept from the legacy "cream" palette so
  /// existing call sites compile unchanged after the rebrand; prefer
  /// `background` for new code.
  public static let cream = Color(hex: 0xFFFFFF)

  /// Preferred name for the page background. Aliases `cream`; new
  /// surfaces should adopt this token so the eventual `cream` removal
  /// is a mechanical rename, not a visual review.
  public static let background = Color(hex: 0xFFFFFF)

  /// Aliased to `primary` after the rebrand — call sites that reach for
  /// `accent` get the same green. Will be removed in a future cleanup
  /// once usages collapse to `primary`.
  public static let accent = Color(hex: 0x3B9322)

  /// Frosted-glass overlay (white @ 8% opacity). Applied on top of any
  /// surface that needs the spec's "frosted dispensary card" look.
  public static let glass = Color.white.opacity(0.08)

  /// Status / semantic tones — wired into `DankBadge` and validation
  /// states on `DankInput`. Hex values picked for AA contrast on white.
  public enum Semantic {
    public static let success = Color(hex: 0x2E7D32)
    public static let warning = Color(hex: 0xB07A12)
    public static let danger = Color(hex: 0xB3261E)
    public static let info = Color(hex: 0x1F4E8C)
  }

  /// Text tones tuned for the white background.
  public enum Text {
    public static let primary = Color(hex: 0x0F1A0D)
    public static let secondary = Color(hex: 0x4A5A4A)
    public static let muted = Color(hex: 0x7A8A7A)
    /// Foreground for content sitting on the primary green fill.
    public static let onPrimary = Color(hex: 0xFFFFFF)
    /// Preferred name for content sitting on the page background. Same
    /// pigment as `primary` — kept distinct so the intent reads at the
    /// call site.
    public static let onBackground = Color(hex: 0x0F1A0D)
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
    .init(name: "primary", hex: 0x3B9322),
    .init(name: "primaryDark", hex: 0x256014),
    .init(name: "cream", hex: 0xFFFFFF),
    .init(name: "background", hex: 0xFFFFFF),
    .init(name: "accent", hex: 0x3B9322),
    .init(name: "semantic.success", hex: 0x2E7D32),
    .init(name: "semantic.warning", hex: 0xB07A12),
    .init(name: "semantic.danger", hex: 0xB3261E),
    .init(name: "semantic.info", hex: 0x1F4E8C),
    .init(name: "text.primary", hex: 0x0F1A0D),
    .init(name: "text.secondary", hex: 0x4A5A4A),
    .init(name: "text.muted", hex: 0x7A8A7A),
    .init(name: "text.onPrimary", hex: 0xFFFFFF),
    .init(name: "text.onBackground", hex: 0x0F1A0D),
  ]
}
