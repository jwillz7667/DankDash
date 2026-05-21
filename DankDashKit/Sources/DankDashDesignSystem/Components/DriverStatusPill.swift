import SwiftUI
import DankDashDomain

/// Driver-side analog of ``OrderStatusPill``: tone-coded capsule that
/// reads `DriverStatus` cases and renders the brand's color + label.
///
/// Tone bucketing:
/// - `.online` → success (driver is taking offers)
/// - `.offline` → neutral (no shift active)
/// - `.enRoutePickup`, `.enRouteDropoff` → info (machine-driven, in motion)
/// - `.onBreak` → warning (temporary unavailability — recoverable)
/// - `.unavailable` → danger (soft unavailability — recoverable)
public struct DriverStatusPill: View {
  private let status: DriverStatus

  public init(status: DriverStatus) {
    self.status = status
  }

  public var body: some View {
    HStack(spacing: DankSpacing.xxs) {
      Circle()
        .fill(dotColor)
        .frame(width: 6, height: 6)
        .accessibilityHidden(true)
      Text(label)
        .font(DankFont.caption)
        .foregroundStyle(textColor)
    }
    .padding(.horizontal, DankSpacing.sm)
    .padding(.vertical, DankSpacing.xxs)
    .background(backgroundColor)
    .clipShape(Capsule())
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Driver status: \(label)")
  }

  public var label: String {
    status.displayLabel
  }

  public var tone: Tone {
    Self.tone(for: status)
  }

  public static func tone(for status: DriverStatus) -> Tone {
    switch status {
    case .online: .success
    case .offline: .neutral
    case .enRoutePickup, .enRouteDropoff: .info
    case .onBreak: .warning
    case .unavailable: .danger
    }
  }

  public enum Tone: Sendable, Equatable, CaseIterable {
    case neutral, success, warning, danger, info
  }

  private var dotColor: Color {
    switch tone {
    case .neutral: DankColor.Text.muted
    case .success: DankColor.Semantic.success
    case .warning: DankColor.Semantic.warning
    case .danger: DankColor.Semantic.danger
    case .info: DankColor.Semantic.info
    }
  }

  private var textColor: Color {
    switch tone {
    case .neutral: DankColor.Text.primary
    case .success, .warning, .danger, .info: .white
    }
  }

  private var backgroundColor: Color {
    switch tone {
    case .neutral: DankColor.primary.opacity(0.10)
    case .success: DankColor.Semantic.success
    case .warning: DankColor.Semantic.warning
    case .danger: DankColor.Semantic.danger
    case .info: DankColor.Semantic.info
    }
  }
}

#Preview {
  VStack(alignment: .leading, spacing: DankSpacing.xs) {
    ForEach(DriverStatus.allCases, id: \.self) { status in
      DriverStatusPill(status: status)
    }
  }
  .padding()
  .background(DankColor.cream)
}
