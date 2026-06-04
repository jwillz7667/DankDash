import SwiftUI

/// Server-cart expiry countdown. The server cart's TTL is 30 minutes
/// from the last touch; the banner appears once the time remaining
/// crosses 5 minutes, shifts to "amber" inside 5 minutes, and "red"
/// inside the final minute.
///
/// The caller is responsible for ticking — passing `remaining` derived
/// from `Cart.expiresAt - now` each second. The view itself is stateless
/// so a parent reducer can drive the countdown without holding a timer
/// in this layer.
public struct CartExpiryBanner: View {
  private let remaining: TimeInterval

  public init(remaining: TimeInterval) {
    self.remaining = remaining
  }

  public var body: some View {
    if let tone = displayTone {
      HStack(spacing: DankSpacing.xs) {
        Image(systemName: "clock")
          .foregroundStyle(tone.iconColor)
          .accessibilityHidden(true)
        Text(message)
          .font(DankFont.caption.weight(.semibold))
          .foregroundStyle(tone.textColor)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, DankSpacing.md)
      .padding(.vertical, DankSpacing.sm)
      .background(tone.background)
      .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
      .accessibilityElement(children: .combine)
      .accessibilityLabel(accessibilityLabel)
    }
  }

  /// Returns nil for "more than 5 minutes" — the banner stays hidden;
  /// .warning between 5 min and 1 min; .critical inside 1 min;
  /// .expired once the deadline has passed.
  public var displayTone: Tone? {
    switch remaining {
    case ..<0: return .expired
    case 0..<60: return .critical
    case 60..<300: return .warning
    default: return nil
    }
  }

  public enum Tone: Sendable {
    case warning, critical, expired

    var iconColor: Color {
      switch self {
      case .warning: DankColor.Semantic.warning
      case .critical, .expired: DankColor.Semantic.danger
      }
    }

    var textColor: Color {
      switch self {
      case .warning: DankColor.Text.primary
      case .critical, .expired: .white
      }
    }

    var background: Color {
      switch self {
      case .warning: DankColor.Semantic.warning.opacity(0.18)
      case .critical, .expired: DankColor.Semantic.danger
      }
    }
  }

  private var message: String {
    if remaining < 0 {
      return "Cart expired — items refreshed"
    }
    let minutes = Int(remaining / 60)
    let seconds = Int(remaining.truncatingRemainder(dividingBy: 60))
    return String(format: "Cart expires in %d:%02d", minutes, seconds)
  }

  private var accessibilityLabel: String {
    if remaining < 0 {
      return "Cart has expired"
    }
    let totalSeconds = Int(remaining)
    let minutes = totalSeconds / 60
    let seconds = totalSeconds % 60
    if minutes > 0 {
      return "Cart expires in \(minutes) minutes \(seconds) seconds"
    }
    return "Cart expires in \(seconds) seconds"
  }
}

#Preview {
  VStack(spacing: DankSpacing.sm) {
    CartExpiryBanner(remaining: 240) // amber
    CartExpiryBanner(remaining: 45)  // critical
    CartExpiryBanner(remaining: -1)  // expired
    CartExpiryBanner(remaining: 600) // hidden
  }
  .padding()
  .background(DankColor.cream)
}
