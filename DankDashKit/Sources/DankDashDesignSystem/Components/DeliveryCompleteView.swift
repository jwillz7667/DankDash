import SwiftUI
import DankDashDomain

/// Success state for ``DeliveryCompleteFeature``. Renders the
/// checkmark + the customer's masked name + an earnings preview
/// (payout estimate from the order) + a single "Back to Shift" CTA.
///
/// `isConfirming = true` swaps the checkmark for a spinner while the
/// `POST /v1/driver/orders/:id/delivery-confirm` is in flight. After
/// success the view stays mounted until the reducer sends `.dismissed`
/// — the driver gets a beat to see the confirmation before the
/// transition.
public struct DeliveryCompleteView: View {
  private let customerDisplayName: String
  private let payoutEstimateCents: Int?
  private let isConfirming: Bool
  private let isCompleted: Bool
  private let errorBanner: String?
  private let onBackToShift: () -> Void
  private let onRetry: () -> Void

  public init(
    customerDisplayName: String,
    payoutEstimateCents: Int?,
    isConfirming: Bool,
    isCompleted: Bool,
    errorBanner: String? = nil,
    onBackToShift: @escaping () -> Void,
    onRetry: @escaping () -> Void
  ) {
    self.customerDisplayName = customerDisplayName
    self.payoutEstimateCents = payoutEstimateCents
    self.isConfirming = isConfirming
    self.isCompleted = isCompleted
    self.errorBanner = errorBanner
    self.onBackToShift = onBackToShift
    self.onRetry = onRetry
  }

  public var body: some View {
    VStack(spacing: DankSpacing.xl) {
      Spacer()
      icon
      title
      summary
      if let errorBanner {
        Text(errorBanner)
          .font(DankFont.bodySmall)
          .foregroundStyle(DankColor.Semantic.danger)
          .multilineTextAlignment(.center)
      }
      Spacer()
      ctaButton
    }
    .padding(DankSpacing.lg)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(DankColor.background)
  }

  @ViewBuilder private var icon: some View {
    if isConfirming {
      ProgressView()
        .progressViewStyle(.circular)
        .scaleEffect(1.6)
        .tint(DankColor.primary)
        .frame(width: 96, height: 96)
    } else if isCompleted {
      Image(systemName: "checkmark.seal.fill")
        .font(.system(size: 72, weight: .semibold))
        .foregroundStyle(DankColor.Semantic.success)
        .frame(width: 96, height: 96)
        .background(DankColor.Semantic.success.opacity(0.12))
        .clipShape(Circle())
    } else if errorBanner != nil {
      Image(systemName: "exclamationmark.triangle.fill")
        .font(.system(size: 72, weight: .semibold))
        .foregroundStyle(DankColor.Semantic.danger)
        .frame(width: 96, height: 96)
        .background(DankColor.Semantic.danger.opacity(0.12))
        .clipShape(Circle())
    } else {
      Image(systemName: "shippingbox.fill")
        .font(.system(size: 72, weight: .semibold))
        .foregroundStyle(DankColor.primary)
        .frame(width: 96, height: 96)
        .background(DankColor.primary.opacity(0.12))
        .clipShape(Circle())
    }
  }

  private var title: some View {
    Text(Self.title(isConfirming: isConfirming, isCompleted: isCompleted, hasError: errorBanner != nil))
      .font(DankFont.title)
      .foregroundStyle(DankColor.Text.onBackground)
      .multilineTextAlignment(.center)
  }

  public static func title(isConfirming: Bool, isCompleted: Bool, hasError: Bool) -> String {
    if isConfirming { return "Confirming delivery…" }
    if isCompleted { return "Delivered" }
    if hasError { return "Couldn't confirm delivery" }
    return "Mark as delivered"
  }

  private var summary: some View {
    VStack(spacing: DankSpacing.xs) {
      Text("Delivered to \(customerDisplayName)")
        .font(DankFont.body)
        .foregroundStyle(DankColor.Text.secondary)
        .multilineTextAlignment(.center)
      if let payoutEstimateCents {
        Text(Self.formatPrice(payoutEstimateCents))
          .font(DankFont.display)
          .foregroundStyle(DankColor.primary)
          .accessibilityLabel("Estimated payout \(Self.formatPrice(payoutEstimateCents))")
      }
    }
  }

  @ViewBuilder private var ctaButton: some View {
    if let _ = errorBanner, !isCompleted {
      Button(action: onRetry) {
        Text("Try Again")
          .font(DankFont.headline)
          .foregroundStyle(DankColor.Text.onPrimary)
          .frame(maxWidth: .infinity, minHeight: 52)
          .background(DankColor.primary)
          .clipShape(Capsule())
      }
      .accessibilityLabel("Retry delivery confirmation")
    } else {
      Button(action: onBackToShift) {
        Text("Back to Shift")
          .font(DankFont.headline)
          .foregroundStyle(DankColor.Text.onPrimary)
          .frame(maxWidth: .infinity, minHeight: 52)
          .background(DankColor.primary)
          .clipShape(Capsule())
      }
      .disabled(isConfirming)
      .opacity(isConfirming ? 0.5 : 1)
      .accessibilityLabel("Back to shift home")
    }
  }

  public static func formatPrice(_ cents: Int) -> String {
    let dollars = Decimal(cents) / 100
    let formatter = NumberFormatter()
    formatter.numberStyle = .currency
    formatter.locale = Locale(identifier: "en_US")
    return formatter.string(from: dollars as NSDecimalNumber) ?? "$0.00"
  }
}

#Preview {
  DeliveryCompleteView(
    customerDisplayName: "Sam J.",
    payoutEstimateCents: 1450,
    isConfirming: false,
    isCompleted: true,
    errorBanner: nil,
    onBackToShift: {},
    onRetry: {}
  )
}
