import CoreGraphics

/// 4-pt spacing scale. Values come from
/// `packages/design-tokens/src/tokens.ts` via codegen — to change a
/// step, edit the TypeScript source and run
/// `pnpm --filter @dankdash/design-tokens build`.
public enum DankSpacing {
  public static let xxs = GeneratedTokens.Spacing.xxs
  public static let xs = GeneratedTokens.Spacing.xs
  public static let sm = GeneratedTokens.Spacing.sm
  public static let md = GeneratedTokens.Spacing.md
  public static let lg = GeneratedTokens.Spacing.lg
  public static let xl = GeneratedTokens.Spacing.xl
  public static let xxl = GeneratedTokens.Spacing.xxl

  public static let allTokens: [(name: String, value: CGFloat)] = [
    ("xxs", xxs), ("xs", xs), ("sm", sm), ("md", md), ("lg", lg), ("xl", xl), ("xxl", xxl),
  ]
}
