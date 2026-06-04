import SwiftUI

/// Renders the canonical DankDash brand mark — the cart-with-leaf glyph
/// shipped at `BrandLogo.imageset` in each app target's Assets catalog.
/// The image asset lives in the **app bundle** (consumer and driver each
/// embed their own copy so the design-system Swift package can stay
/// asset-free); we resolve it via `bundle: .main`, which is the consuming
/// app's main bundle at runtime.
///
/// Variants control the surrounding chrome, not the mark itself:
///   - ``Variant/mark`` — image alone, square-bounded.
///   - ``Variant/wordmark`` — "DankDash" rendered as a rounded display
///     font (no separate wordmark asset on iOS yet).
///   - ``Variant/full`` — mark + wordmark on one horizontal row.
///
/// `size` is interpreted as the **height** of the rendered logo; width
/// derives from the image's intrinsic aspect ratio so the brand never
/// squishes regardless of the caller's frame.
public struct DankLogo: View {
  public enum Variant: Sendable, CaseIterable {
    case mark, wordmark, full
  }

  private let variant: Variant
  private let size: CGFloat

  public init(_ variant: Variant = .full, size: CGFloat = 64) {
    self.variant = variant
    self.size = size
  }

  public var body: some View {
    switch variant {
    case .mark:
      markImage
        .accessibilityLabel("DankDash logo")
    case .wordmark:
      wordmarkText
        .accessibilityLabel("DankDash")
    case .full:
      // The wordmark is a fixed-point font, so on a narrow proposal the
      // mark + text row can exceed the device width and wrap. lineLimit +
      // minimumScaleFactor let the wordmark shrink instead of wrapping;
      // the mark stays height-bounded and width-safe (see markImage).
      HStack(spacing: DankSpacing.sm) {
        markImage
        wordmarkText
          .lineLimit(1)
          .minimumScaleFactor(0.5)
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("DankDash")
    }
  }

  private var markImage: some View {
    // `maxHeight` (not exact `height`) keeps the proposed width intact so
    // `.fit` can shrink the mark when the container is narrower than the
    // asset's intrinsic width — the mark can never overflow horizontally.
    Image("BrandLogo", bundle: .main)
      .resizable()
      .renderingMode(.original)
      .aspectRatio(contentMode: .fit)
      .frame(maxHeight: size)
  }

  private var wordmarkText: some View {
    Text("DankDash")
      .font(.system(size: size * 0.5, weight: .bold, design: .rounded))
      .foregroundStyle(DankColor.primary)
  }
}

#Preview {
  VStack(spacing: DankSpacing.lg) {
    DankLogo(.mark, size: 48)
    DankLogo(.wordmark, size: 32)
    DankLogo(.full, size: 56)
  }
  .padding()
  .background(DankColor.cream)
}
