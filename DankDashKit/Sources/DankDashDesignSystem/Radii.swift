import CoreGraphics

/// Corner radius scale. `pill` is bigger than any expected element height
/// so a button stays oval at any size.
public enum DankRadius {
  public static let sm: CGFloat = 6
  public static let md: CGFloat = 12
  public static let lg: CGFloat = 20
  public static let pill: CGFloat = 999

  public static let allTokens: [(name: String, value: CGFloat)] = [
    ("sm", sm), ("md", md), ("lg", lg), ("pill", pill),
  ]
}
