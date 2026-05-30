import CoreGraphics

/// 4-pt spacing scale. Every padding / gap in the app should pull from
/// this ladder; ad-hoc `padding(12)` reads as a smell during code review.
public enum DankSpacing {
  public static let xxs: CGFloat = 4
  public static let xs: CGFloat = 8
  public static let sm: CGFloat = 12
  public static let md: CGFloat = 16
  public static let lg: CGFloat = 24
  public static let xl: CGFloat = 32
  public static let xxl: CGFloat = 48

  public static let allTokens: [(name: String, value: CGFloat)] = [
    ("xxs", xxs), ("xs", xs), ("sm", sm), ("md", md), ("lg", lg), ("xl", xl), ("xxl", xxl),
  ]
}
