import SwiftUI
import DankDashDomain

/// Vertical milestone stepper for the order-tracking screen. Collapses
/// the 20-state `OrderStatus` enum to six user-facing stages plus a
/// failure branch, so the UI doesn't whip from "ID check" to "ID
/// verified" mid-screen — those are both `arriving` to the user.
///
/// The mapping is deliberate and kept inside this component so the
/// reducer can publish raw `OrderStatus` and the view layer collapses:
///
/// - `placed` → **Placed**
/// - `accepted` / `prepping` → **Preparing**
/// - `awaitingDriver` (dispatch open, no driver yet) → **Ready for pickup**
/// - `driverAssigned` / `enRoutePickup` → **Driver en route to store**
/// - `pickedUp` / `enRouteDropoff` → **On the way**
/// - `arrivedAtDropoff` / `idScanPending` / `idScanPassed` → **Arriving**
/// - `delivered` → **Delivered**
///
/// Terminal failures (`rejected`, `dispatchFailed`, `idScanFailed`,
/// `canceled`, `returnedToStore`, `disputed`) collapse to a single
/// failure card rendered in place of the timeline. `paymentFailed` is
/// its own dedicated copy because the recovery action differs (re-issue
/// handoff, not contact support).
public struct OrderStatusTimeline: View {
  public enum Milestone: Int, CaseIterable, Sendable {
    case placed
    case preparing
    case readyForPickup
    case driverAssigned
    case onTheWay
    case arriving
    case delivered

    var label: String {
      switch self {
      case .placed: return "Placed"
      case .preparing: return "Preparing"
      case .readyForPickup: return "Ready for pickup"
      case .driverAssigned: return "Driver en route to store"
      case .onTheWay: return "On the way"
      case .arriving: return "Arriving"
      case .delivered: return "Delivered"
      }
    }

    var icon: String {
      switch self {
      case .placed: return "checkmark.circle"
      case .preparing: return "bag"
      case .readyForPickup: return "bag.badge.clock"
      case .driverAssigned: return "car.fill"
      case .onTheWay: return "car.fill"
      case .arriving: return "house.circle"
      case .delivered: return "checkmark.seal.fill"
      }
    }
  }

  /// Failure copy is split into two buckets: `paymentFailed` resolves
  /// by issuing a fresh checkout-handoff token, every other terminal
  /// failure resolves by talking to support.
  public enum FailureKind: Sendable {
    case paymentFailed
    case other(OrderStatus)

    var title: String {
      switch self {
      case .paymentFailed: return "Payment failed"
      case .other: return "There was a problem"
      }
    }

    var detail: String {
      switch self {
      case .paymentFailed:
        return "Your payment didn't go through. Restart checkout to try again."
      case .other(.rejected):
        return "The dispensary couldn't accept this order."
      case .other(.canceled):
        return "This order was canceled."
      case .other(.idScanFailed):
        return "We couldn't verify the ID at the door."
      case .other(.returnedToStore):
        return "The driver couldn't complete delivery and returned the order."
      case .other(.disputed):
        return "This order is under review."
      case .other(.dispatchFailed):
        return "We couldn't find a driver for this order. Any charge will be reversed."
      case .other:
        return "Contact support for help with this order."
      }
    }

    var ctaLabel: String {
      switch self {
      case .paymentFailed: return "Restart checkout"
      case .other: return "Contact support"
      }
    }
  }

  private let status: OrderStatus

  public init(status: OrderStatus) {
    self.status = status
  }

  public var body: some View {
    if let failure = failureKind {
      failureCard(failure)
    } else {
      timeline
    }
  }

  private var failureKind: FailureKind? {
    switch status {
    case .paymentFailed: return .paymentFailed
    case .rejected, .dispatchFailed, .canceled, .idScanFailed, .returnedToStore, .disputed:
      return .other(status)
    default:
      return nil
    }
  }

  /// Decides which milestone a happy-path `OrderStatus` belongs to.
  /// Anything outside the happy path (terminal failures, the pickup
  /// leaf) is filtered earlier by `failureKind`; `readyForPickup` maps
  /// to `.preparing` because the consumer surface never reaches it.
  static func milestone(for status: OrderStatus) -> Milestone {
    switch status {
    case .placed: return .placed
    case .accepted, .prepping: return .preparing
    // `awaiting_driver` = the dispatch offer is live but no driver has
    // accepted yet → "Ready for pickup", NOT a driver-stage milestone.
    case .readyForPickup, .awaitingDriver: return .readyForPickup
    // A driver has committed: driver_assigned + en_route_pickup are both
    // "heading to the store".
    case .driverAssigned, .enRoutePickup: return .driverAssigned
    case .pickedUp, .enRouteDropoff: return .onTheWay
    case .arrivedAtDropoff, .idScanPending, .idScanPassed: return .arriving
    case .delivered: return .delivered
    case .paymentFailed, .rejected, .dispatchFailed, .canceled,
         .idScanFailed, .returnedToStore, .disputed:
      return .placed
    }
  }

  private var current: Milestone { Self.milestone(for: status) }

  private var timeline: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(Milestone.allCases.enumerated()), id: \.offset) { index, milestone in
        row(for: milestone, isLast: index == Milestone.allCases.count - 1)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Order progress, \(current.label)")
  }

  private func row(for milestone: Milestone, isLast: Bool) -> some View {
    let state = state(for: milestone)
    return HStack(alignment: .top, spacing: DankSpacing.md) {
      VStack(spacing: 0) {
        ZStack {
          Circle()
            .fill(state.fill)
            .frame(width: 28, height: 28)
          Image(systemName: milestone.icon)
            .font(.system(size: 13, weight: .bold))
            .foregroundStyle(state.iconColor)
        }
        if !isLast {
          Rectangle()
            .fill(state.lineColor)
            .frame(width: 2)
            .frame(maxHeight: .infinity)
        }
      }
      .frame(width: 28)

      VStack(alignment: .leading, spacing: DankSpacing.xxs) {
        Text(milestone.label)
          .font(DankFont.body.weight(state.textWeight))
          .foregroundStyle(state.textColor)
        if milestone == current, let caption = currentCaption {
          Text(caption)
            .font(DankFont.caption)
            .foregroundStyle(DankColor.Text.secondary)
        }
      }
      .padding(.bottom, isLast ? 0 : DankSpacing.md)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityLabel(for: milestone, state: state))
  }

  /// Sub-status caption — what the order is actually doing inside the
  /// active milestone bucket. Empty for milestones that already match
  /// their `OrderStatus` 1:1 (the displayLabel would be redundant).
  private var currentCaption: String? {
    switch status {
    case .placed, .delivered: return nil
    case .accepted: return "Order accepted"
    case .prepping: return "Packing your order"
    case .awaitingDriver: return "Finding your driver"
    case .driverAssigned: return "Heading to store"
    case .enRoutePickup: return "Driver heading to store"
    case .pickedUp: return "Driver has your order"
    case .enRouteDropoff: return "Heading to your address"
    case .arrivedAtDropoff: return "Driver has arrived"
    case .idScanPending: return "Verifying your ID"
    case .idScanPassed: return "ID verified"
    default: return nil
    }
  }

  private enum RowState {
    case completed, active, upcoming

    var fill: Color {
      switch self {
      case .completed: return DankColor.Semantic.success
      case .active: return DankColor.primary
      case .upcoming: return DankColor.primary.opacity(0.12)
      }
    }

    var iconColor: Color {
      switch self {
      case .completed, .active: return DankColor.Text.onPrimary
      case .upcoming: return DankColor.primary.opacity(0.55)
      }
    }

    var lineColor: Color {
      switch self {
      case .completed: return DankColor.Semantic.success
      case .active, .upcoming: return DankColor.primary.opacity(0.18)
      }
    }

    var textColor: Color {
      switch self {
      case .completed, .active: return DankColor.Text.primary
      case .upcoming: return DankColor.Text.muted
      }
    }

    var textWeight: Font.Weight {
      switch self {
      case .active: return .semibold
      case .completed, .upcoming: return .regular
      }
    }
  }

  private func state(for milestone: Milestone) -> RowState {
    let currentRaw = current.rawValue
    let targetRaw = milestone.rawValue
    if targetRaw < currentRaw { return .completed }
    if targetRaw == currentRaw {
      return status == .delivered && milestone == .delivered ? .completed : .active
    }
    return .upcoming
  }

  private func accessibilityLabel(for milestone: Milestone, state: RowState) -> String {
    switch state {
    case .completed: return "\(milestone.label), completed"
    case .active: return "\(milestone.label), in progress"
    case .upcoming: return "\(milestone.label), upcoming"
    }
  }

  private func failureCard(_ failure: FailureKind) -> some View {
    VStack(alignment: .leading, spacing: DankSpacing.sm) {
      HStack(spacing: DankSpacing.sm) {
        Image(systemName: "exclamationmark.triangle.fill")
          .font(.system(size: 20, weight: .bold))
          .foregroundStyle(DankColor.Semantic.danger)
          .accessibilityHidden(true)
        Text(failure.title)
          .font(DankFont.headline)
          .foregroundStyle(DankColor.Text.primary)
      }
      Text(failure.detail)
        .font(DankFont.bodySmall)
        .foregroundStyle(DankColor.Text.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(DankSpacing.md)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous)
        .fill(DankColor.Semantic.danger.opacity(0.08))
    )
    .overlay(
      RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous)
        .strokeBorder(DankColor.Semantic.danger.opacity(0.35), lineWidth: 1)
    )
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(failure.title). \(failure.detail)")
  }
}

#Preview {
  VStack(alignment: .leading, spacing: DankSpacing.lg) {
    OrderStatusTimeline(status: .placed)
    Divider()
    OrderStatusTimeline(status: .prepping)
    Divider()
    OrderStatusTimeline(status: .enRouteDropoff)
    Divider()
    OrderStatusTimeline(status: .delivered)
    Divider()
    OrderStatusTimeline(status: .paymentFailed)
    Divider()
    OrderStatusTimeline(status: .canceled)
  }
  .padding()
  .background(DankColor.cream)
}
