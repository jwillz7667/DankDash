import SwiftUI

/// Apply the standard DankCard chrome (cream background, soft shadow,
/// continuous corner) to any view via the `.dankCard()` modifier. Useful
/// when content needs the card chrome without an extra wrapper view in
/// the hierarchy at the call site.
public extension View {
  func dankCard(
    style: DankCardStyle = .solid,
    padding: CGFloat = DankSpacing.md
  ) -> some View {
    DankCard(style: style, padding: padding) { self }
  }
}
