import SwiftUI
import DankDashDomain

/// ID scan handoff screen body — what the driver sees once they tap
/// "I've Arrived" on the dropoff card. Wraps the Veriff SDK launch in
/// an explainer + Begin Scan CTA and surfaces a small escalation
/// triplet (re-scan / contact support / return to dispensary) on
/// repeat failure.
///
/// The view is a pure projection of ``IDScanStatus``:
///
///   - `.notStarted` → explainer + Begin Scan
///   - `.sessionRequested` / `.sdkInProgress` / `.awaitingResult`
///     → spinner + status caption ("Verifying ID…")
///   - `.passed` → checkmark + "Verified" handoff banner
///   - `.failed` with attempts remaining → red banner + Re-scan
///   - `.failed` with no attempts remaining → 3 escalation buttons
public struct IDScanLaunchView: View {
  private let status: IDScanStatus
  private let attemptsRemaining: Int
  private let onBeginScan: () -> Void
  private let onRetry: () -> Void
  private let onContactSupport: () -> Void
  private let onReturnToDispensary: () -> Void

  public init(
    status: IDScanStatus,
    attemptsRemaining: Int,
    onBeginScan: @escaping () -> Void,
    onRetry: @escaping () -> Void,
    onContactSupport: @escaping () -> Void,
    onReturnToDispensary: @escaping () -> Void
  ) {
    self.status = status
    self.attemptsRemaining = attemptsRemaining
    self.onBeginScan = onBeginScan
    self.onRetry = onRetry
    self.onContactSupport = onContactSupport
    self.onReturnToDispensary = onReturnToDispensary
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: DankSpacing.lg) {
      iconAndTitle
      explainer
      Spacer()
      ctaSection
    }
    .padding(DankSpacing.lg)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(DankColor.background)
  }

  // MARK: - Header

  private var iconAndTitle: some View {
    VStack(alignment: .leading, spacing: DankSpacing.md) {
      Image(systemName: iconName)
        .font(.system(size: 48, weight: .semibold))
        .foregroundStyle(iconColor)
        .frame(width: 72, height: 72)
        .background(iconColor.opacity(0.12))
        .clipShape(Circle())
      Text(title)
        .font(DankFont.title)
        .foregroundStyle(DankColor.Text.onBackground)
    }
  }

  private var iconName: String {
    switch status {
    case .notStarted: "person.text.rectangle"
    case .sessionRequested, .sdkInProgress, .awaitingResult: "hourglass"
    case .passed: "checkmark.seal.fill"
    case .failed: "exclamationmark.triangle.fill"
    }
  }

  private var iconColor: Color {
    switch status {
    case .passed: DankColor.Semantic.success
    case .failed: DankColor.Semantic.danger
    default: DankColor.primary
    }
  }

  public var title: String {
    Self.title(for: status)
  }

  public static func title(for status: IDScanStatus) -> String {
    switch status {
    case .notStarted: "Verify the customer's ID"
    case .sessionRequested, .sdkInProgress, .awaitingResult: "Verifying ID…"
    case .passed: "ID verified"
    case .failed: "Couldn't verify"
    }
  }

  // MARK: - Body

  private var explainer: some View {
    Text(explainerCopy)
      .font(DankFont.body)
      .foregroundStyle(DankColor.Text.secondary)
      .multilineTextAlignment(.leading)
  }

  public var explainerCopy: String {
    Self.explainerCopy(for: status, attemptsRemaining: attemptsRemaining)
  }

  public static func explainerCopy(
    for status: IDScanStatus,
    attemptsRemaining: Int
  ) -> String {
    switch status {
    case .notStarted:
      return "Minnesota law requires ID verification at handoff. The customer's camera will open to capture their license and a quick selfie."
    case .sessionRequested:
      return "Starting verification…"
    case .sdkInProgress:
      return "Customer is completing the scan."
    case .awaitingResult:
      return "Waiting for verification result. This usually takes a few seconds."
    case .passed:
      return "You can complete the delivery."
    case .failed(let reason):
      if attemptsRemaining > 0 {
        let s = attemptsRemaining == 1 ? "" : "s"
        return "\(reason). \(attemptsRemaining) attempt\(s) remaining."
      }
      return "\(reason). No more attempts — please choose what to do next."
    }
  }

  // MARK: - CTAs

  @ViewBuilder private var ctaSection: some View {
    switch status {
    case .notStarted:
      primaryButton(title: "Begin Scan", action: onBeginScan)
    case .sessionRequested, .sdkInProgress, .awaitingResult:
      HStack(spacing: DankSpacing.sm) {
        ProgressView().progressViewStyle(.circular)
        Text("Working…")
          .font(DankFont.body)
          .foregroundStyle(DankColor.Text.muted)
      }
      .frame(maxWidth: .infinity, minHeight: 52)
    case .passed:
      EmptyView()
    case .failed:
      if attemptsRemaining > 0 {
        primaryButton(title: "Re-scan ID", action: onRetry)
      } else {
        escalationStack
      }
    }
  }

  private var escalationStack: some View {
    VStack(spacing: DankSpacing.sm) {
      escalationButton(title: "Re-scan ID", action: onRetry, isPrimary: false)
      escalationButton(title: "Contact Support", action: onContactSupport, isPrimary: false)
      escalationButton(
        title: "Return to Dispensary",
        action: onReturnToDispensary,
        isPrimary: true
      )
    }
  }

  private func primaryButton(title: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Text(title)
        .font(DankFont.headline)
        .foregroundStyle(DankColor.Text.onPrimary)
        .frame(maxWidth: .infinity, minHeight: 52)
        .background(DankColor.primary)
        .clipShape(Capsule())
    }
    .accessibilityLabel(title)
  }

  private func escalationButton(
    title: String,
    action: @escaping () -> Void,
    isPrimary: Bool
  ) -> some View {
    Button(action: action) {
      Text(title)
        .font(DankFont.headline)
        .foregroundStyle(isPrimary ? DankColor.Text.onPrimary : DankColor.Text.onBackground)
        .frame(maxWidth: .infinity, minHeight: 52)
        .background(isPrimary ? DankColor.primary : DankColor.Text.muted.opacity(0.12))
        .clipShape(Capsule())
    }
    .accessibilityLabel(title)
  }
}

#Preview {
  VStack(spacing: DankSpacing.xl) {
    IDScanLaunchView(
      status: .notStarted,
      attemptsRemaining: 3,
      onBeginScan: {},
      onRetry: {},
      onContactSupport: {},
      onReturnToDispensary: {}
    )
    IDScanLaunchView(
      status: .failed(reason: "ID not detected"),
      attemptsRemaining: 0,
      onBeginScan: {},
      onRetry: {},
      onContactSupport: {},
      onReturnToDispensary: {}
    )
  }
  .background(DankColor.background)
}
