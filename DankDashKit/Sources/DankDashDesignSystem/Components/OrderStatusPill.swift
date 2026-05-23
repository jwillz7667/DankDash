import SwiftUI
import DankDashDomain

/// Pill-shaped status indicator for the Orders list + tracking surfaces.
/// Maps each of the 19 `OrderStatus` cases to a single human-facing
/// label + a tone bucket (in-progress, success, warning, danger).
///
/// Terminal failure states (`rejected`, `canceled`, `idScanFailed`,
/// `returnedToStore`, `disputed`, `paymentFailed`) all read as
/// "danger" — the user-facing copy is intentionally specific
/// ("Canceled" vs "Returned to store") so support diagnostics tell the
/// real story, but the tone is uniform.
public struct OrderStatusPill: View {
  private let status: OrderStatus

  public init(status: OrderStatus) {
    self.status = status
  }

  public var body: some View {
    HStack(spacing: DankSpacing.xxs) {
      Circle()
        .fill(tone.dotColor)
        .frame(width: 6, height: 6)
        .accessibilityHidden(true)
      Text(label)
        .font(DankFont.caption)
        .foregroundStyle(tone.textColor)
    }
    .padding(.horizontal, DankSpacing.sm)
    .padding(.vertical, DankSpacing.xxs)
    .background(tone.backgroundColor)
    .clipShape(Capsule())
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Status: \(label)")
  }

  public var label: String {
    Self.label(for: status)
  }

  public var tone: Tone {
    Self.tone(for: status)
  }

  // MARK: - Label + tone tables

  /// User-facing label per status. These are the strings the timeline
  /// + the list row read; centralizing them prevents the two surfaces
  /// from drifting apart.
  public static func label(for status: OrderStatus) -> String {
    switch status {
    case .placed: "Placed"
    case .paymentFailed: "Payment failed"
    case .accepted: "Accepted"
    case .rejected: "Rejected"
    case .prepping: "Preparing"
    case .readyForPickup: "Ready for pickup"
    case .awaitingDriver: "Waiting for driver"
    case .driverAssigned: "Driver assigned"
    case .enRoutePickup: "Driver heading to store"
    case .pickedUp: "Picked up"
    case .enRouteDropoff: "On the way"
    case .arrivedAtDropoff: "Arriving"
    case .idScanPending: "Verifying ID"
    case .idScanPassed: "ID verified"
    case .idScanFailed: "ID check failed"
    case .delivered: "Delivered"
    case .returnedToStore: "Returned to store"
    case .canceled: "Canceled"
    case .disputed: "Disputed"
    }
  }

  /// Bucketed tone — drives both the dot color + the pill background.
  /// Happy-path early states (`placed`, `accepted`, `prepping`) read as
  /// info; mid-flight states as "in motion" (info); `delivered` /
  /// `idScanPassed` as success; everything terminal-failure-shaped as
  /// danger.
  public static func tone(for status: OrderStatus) -> Tone {
    switch status {
    case .placed, .accepted, .prepping, .readyForPickup, .awaitingDriver:
      return .info
    case .driverAssigned, .enRoutePickup, .pickedUp, .enRouteDropoff,
         .arrivedAtDropoff, .idScanPending:
      return .progress
    case .idScanPassed, .delivered:
      return .success
    case .paymentFailed, .rejected, .idScanFailed, .returnedToStore,
         .canceled, .disputed:
      return .danger
    }
  }

  public enum Tone: Sendable {
    case info, progress, success, danger

    var dotColor: Color {
      switch self {
      case .info: DankColor.Semantic.info
      case .progress: DankColor.accent
      case .success: DankColor.Semantic.success
      case .danger: DankColor.Semantic.danger
      }
    }

    var textColor: Color {
      switch self {
      case .info, .progress: DankColor.Text.primary
      case .success: .white
      case .danger: .white
      }
    }

    var backgroundColor: Color {
      switch self {
      case .info: DankColor.Semantic.info.opacity(0.12)
      case .progress: DankColor.accent.opacity(0.18)
      case .success: DankColor.Semantic.success
      case .danger: DankColor.Semantic.danger
      }
    }
  }
}

#Preview {
  VStack(alignment: .leading, spacing: DankSpacing.xs) {
    ForEach(OrderStatus.allCases, id: \.self) { status in
      OrderStatusPill(status: status)
    }
  }
  .padding()
  .background(DankColor.cream)
}
