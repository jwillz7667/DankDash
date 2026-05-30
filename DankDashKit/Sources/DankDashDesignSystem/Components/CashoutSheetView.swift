import SwiftUI

/// Sheet body for the cashout request flow. A single amount input, an
/// inline available-balance hint, an inline error slot for the
/// server's insufficient-funds response, and the Confirm CTA.
///
/// The view is purely controlled — `amountText`, `isSubmitting`,
/// `errorMessage`, and `isConfirmEnabled` all flow in from the parent
/// (the reducer owns parsing + validation). The text field uses a
/// numeric keypad with decimal because the amount is dollars-and-cents,
/// and the prefix `$` is a static label rather than part of the input
/// so the parser doesn't have to peel it back off.
public struct CashoutSheetView: View {
  @Binding private var amountText: String
  private let availableBalanceCents: Int?
  private let isSubmitting: Bool
  private let errorMessage: String?
  private let isConfirmEnabled: Bool
  private let onConfirm: () -> Void
  private let onCancel: () -> Void

  public init(
    amountText: Binding<String>,
    availableBalanceCents: Int?,
    isSubmitting: Bool,
    errorMessage: String?,
    isConfirmEnabled: Bool,
    onConfirm: @escaping () -> Void,
    onCancel: @escaping () -> Void
  ) {
    self._amountText = amountText
    self.availableBalanceCents = availableBalanceCents
    self.isSubmitting = isSubmitting
    self.errorMessage = errorMessage
    self.isConfirmEnabled = isConfirmEnabled
    self.onConfirm = onConfirm
    self.onCancel = onCancel
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: DankSpacing.lg) {
      header
      amountField
      if let availableBalanceCents {
        availableHint(availableBalanceCents)
      }
      if let errorMessage {
        errorBanner(errorMessage)
      }
      Spacer(minLength: DankSpacing.md)
      confirmButton
      cancelButton
    }
    .padding(DankSpacing.lg)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(DankColor.background)
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: DankSpacing.xs) {
      Text("Request cashout")
        .font(DankFont.title)
        .foregroundStyle(DankColor.Text.onBackground)
      Text("We'll send this to your Aeropay account.")
        .font(DankFont.body)
        .foregroundStyle(DankColor.Text.secondary)
    }
  }

  private var amountField: some View {
    HStack(spacing: DankSpacing.xs) {
      Text("$")
        .font(DankFont.display)
        .foregroundStyle(DankColor.Text.muted)
      amountTextField
    }
    .padding(.vertical, DankSpacing.sm)
    .overlay(
      Rectangle()
        .frame(height: 1)
        .foregroundStyle(DankColor.Text.muted.opacity(0.3)),
      alignment: .bottom
    )
  }

  /// `keyboardType(.decimalPad)` is iOS-only; on macOS the package
  /// build skips the modifier so the TextField still renders for
  /// snapshot tests that exercise the layout.
  @ViewBuilder private var amountTextField: some View {
    #if os(iOS)
    TextField("0.00", text: $amountText)
      .font(DankFont.display)
      .foregroundStyle(DankColor.Text.onBackground)
      .keyboardType(.decimalPad)
      .accessibilityLabel("Cashout amount in dollars")
    #else
    TextField("0.00", text: $amountText)
      .font(DankFont.display)
      .foregroundStyle(DankColor.Text.onBackground)
      .accessibilityLabel("Cashout amount in dollars")
    #endif
  }

  private func availableHint(_ cents: Int) -> some View {
    Text("Available: \(Self.formatPrice(cents))")
      .font(DankFont.caption)
      .foregroundStyle(DankColor.Text.muted)
  }

  private func errorBanner(_ message: String) -> some View {
    HStack(alignment: .top, spacing: DankSpacing.xs) {
      Image(systemName: "exclamationmark.triangle.fill")
        .font(DankFont.caption)
        .foregroundStyle(DankColor.Semantic.danger)
      Text(message)
        .font(DankFont.bodySmall)
        .foregroundStyle(DankColor.Semantic.danger)
    }
    .padding(DankSpacing.sm)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(DankColor.Semantic.danger.opacity(0.08))
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
  }

  private var confirmButton: some View {
    Button(action: onConfirm) {
      ZStack {
        Text("Confirm")
          .font(DankFont.headline)
          .foregroundStyle(DankColor.Text.onPrimary)
          .opacity(isSubmitting ? 0 : 1)
        if isSubmitting {
          ProgressView()
            .progressViewStyle(.circular)
            .tint(DankColor.Text.onPrimary)
        }
      }
      .frame(maxWidth: .infinity, minHeight: 52)
      .background(isConfirmEnabled ? DankColor.primary : DankColor.Text.muted.opacity(0.4))
      .clipShape(Capsule())
    }
    .disabled(!isConfirmEnabled || isSubmitting)
    .accessibilityLabel("Confirm cashout request")
  }

  private var cancelButton: some View {
    Button(action: onCancel) {
      Text("Cancel")
        .font(DankFont.headline)
        .foregroundStyle(DankColor.Text.onBackground)
        .frame(maxWidth: .infinity, minHeight: 52)
        .background(DankColor.Text.muted.opacity(0.12))
        .clipShape(Capsule())
    }
    .disabled(isSubmitting)
    .accessibilityLabel("Cancel cashout")
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
  StatefulPreview()
}

private struct StatefulPreview: View {
  @State private var amount: String = ""
  var body: some View {
    CashoutSheetView(
      amountText: $amount,
      availableBalanceCents: 14_350,
      isSubmitting: false,
      errorMessage: nil,
      isConfirmEnabled: false,
      onConfirm: {},
      onCancel: {}
    )
  }
}
