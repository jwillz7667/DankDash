import SwiftUI

/// Exit-boundary CTA — the only path off the cart screen to the Safari
/// hand-off per Apple §10.4. Rendered with a Safari glyph so it's
/// visually unambiguous: the user is about to leave the iOS app and
/// complete checkout on the web.
///
/// Disabled until the cart can legally check out: address selected and
/// the latest validate response says `passed == true`. Loading state
/// covers the round-trip to `POST /v1/auth/checkout-handoff` — the
/// reducer should swap to `isLoading = true` the moment the tap fires
/// and only flip back when the token resolves (or the SafariView
/// dismisses).
public struct CheckoutCTAButton: View {
  private let isLoading: Bool
  private let isEnabled: Bool
  private let action: () -> Void

  public init(
    isLoading: Bool = false,
    isEnabled: Bool = true,
    action: @escaping () -> Void
  ) {
    self.isLoading = isLoading
    self.isEnabled = isEnabled
    self.action = action
  }

  public var body: some View {
    Button(action: action) {
      HStack(spacing: DankSpacing.xs) {
        if isLoading {
          ProgressView()
            .progressViewStyle(.circular)
            .tint(DankColor.Text.onPrimary)
        } else {
          Image(systemName: "safari.fill")
            .font(.system(size: 18, weight: .semibold))
            .accessibilityHidden(true)
        }
        Text(title)
          .font(DankFont.headline)
      }
      .frame(maxWidth: .infinity, minHeight: 56)
      .padding(.horizontal, DankSpacing.lg)
      .background(background)
      .foregroundStyle(DankColor.Text.onPrimary)
      .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
      .opacity(isInteractive ? 1 : 0.5)
    }
    .disabled(!isInteractive)
    .accessibilityLabel(title)
    .accessibilityHint("Opens checkout in Safari to finish payment.")
    .accessibilityAddTraits(.isButton)
  }

  /// "Opens in Safari" is doing two jobs: it tells the user this exits
  /// the app (so the Safari sheet isn't a surprise) and it's the verbal
  /// disclosure the App Review §10.4 path expects on the consumer
  /// surface.
  private var title: String {
    isLoading ? "Preparing checkout…" : "Continue to checkout — opens in Safari"
  }

  private var isInteractive: Bool { isEnabled && !isLoading }

  @ViewBuilder private var background: some View {
    if isInteractive {
      DankColor.primary
    } else {
      DankColor.primary.opacity(0.85)
    }
  }
}

#Preview {
  VStack(spacing: DankSpacing.md) {
    CheckoutCTAButton(action: {})
    CheckoutCTAButton(isLoading: true, action: {})
    CheckoutCTAButton(isEnabled: false, action: {})
  }
  .padding()
  .background(DankColor.cream)
}
