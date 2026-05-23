import SwiftUI

/// Brand color palette. Hex values live in
/// `packages/design-tokens/src/tokens.ts` and are codegen'd into
/// `Generated/Tokens.swift`; this file aliases those constants so the
/// public surface (`DankColor.primary`, `.cream`, `.Semantic.danger`,
/// etc.) stays stable across the consumer iOS app, the Dasher driver
/// app, and any test target that snapshots brand colors.
///
/// To change a brand color, edit the TypeScript source and run
/// `pnpm --filter @dankdash/design-tokens build`. Do not edit literal
/// hex values in this file.
public enum DankColor {
  /// Brand green — primary buttons, focal surfaces, brand mark.
  public static let primary = GeneratedTokens.Palette.primary500

  /// Deeper green for hover/active states.
  public static let primaryDark = GeneratedTokens.Palette.primary600

  /// White surface. Legacy name kept so existing call sites compile;
  /// `background` is the preferred name for new code.
  public static let cream = GeneratedTokens.Palette.background

  /// Page background. Aliases `cream`; adopt this name in new surfaces.
  public static let background = GeneratedTokens.Palette.background

  /// Aliased to `primary` — both names resolve to the brand green.
  public static let accent = GeneratedTokens.Palette.primary500

  /// Translucent white overlay for frosted-glass surfaces.
  public static let glass = GeneratedTokens.Palette.glass

  /// Status / semantic tones for badges, validation states.
  public enum Semantic {
    public static let success = GeneratedTokens.Palette.semanticSuccess
    public static let warning = GeneratedTokens.Palette.semanticWarning
    public static let danger = GeneratedTokens.Palette.semanticDanger
    public static let info = GeneratedTokens.Palette.semanticInfo
  }

  /// Operational status (past-SLA, needs-attention) shared with portal.
  public enum Status {
    public static let ember = GeneratedTokens.Palette.statusEmber
    public static let attention = GeneratedTokens.Palette.statusAttention
  }

  /// Text tones tuned for the white background.
  public enum Text {
    public static let primary = GeneratedTokens.Palette.textPrimary
    public static let secondary = GeneratedTokens.Palette.textSecondary
    public static let muted = GeneratedTokens.Palette.textMuted
    public static let onPrimary = GeneratedTokens.Palette.textOnPrimary
    public static let onBackground = GeneratedTokens.Palette.textOnBackground
  }
}

extension Color {
  /// 24-bit RGB hex literal. Alpha is fixed at 1.0; use `.opacity()` for
  /// translucency. Kept for ad-hoc color construction outside the token
  /// system — prefer `DankColor.*` for anything brand-relevant.
  public init(hex: UInt32) {
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
  /// Inventory of every named brand token, useful for the design
  /// gallery and for regression tests that catch accidental hex edits.
  /// Hex values mirror `packages/design-tokens/src/tokens.ts`; keep
  /// them in sync when adding a new token (the design-tokens build
  /// does not edit this array — it's documentation of the public
  /// surface, not the source of truth for rendered Color values).
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
    .init(name: "status.ember", hex: 0xC75D2C),
    .init(name: "status.attention", hex: 0xC7A03C),
    .init(name: "text.primary", hex: 0x0F1A0D),
    .init(name: "text.secondary", hex: 0x4A5A4A),
    .init(name: "text.muted", hex: 0x7A8A7A),
    .init(name: "text.onPrimary", hex: 0xFFFFFF),
    .init(name: "text.onBackground", hex: 0x0F1A0D),
  ]
}
