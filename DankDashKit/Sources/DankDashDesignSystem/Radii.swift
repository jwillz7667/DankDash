import CoreGraphics

/// Corner radius scale. `pill` is bigger than any expected element
/// height so a button stays oval at any size. Values come from
/// `packages/design-tokens/src/tokens.ts` via codegen.
public enum DankRadius {
  public static let sm = GeneratedTokens.Radius.sm
  public static let md = GeneratedTokens.Radius.md
  public static let lg = GeneratedTokens.Radius.lg
  public static let pill = GeneratedTokens.Radius.pill

  public static let allTokens: [(name: String, value: CGFloat)] = [
    ("sm", sm), ("md", md), ("lg", lg), ("pill", pill),
  ]
}
