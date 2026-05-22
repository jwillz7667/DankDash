import Foundation
import ComposableArchitecture
import DankDashDomain

/// Detail-screen wrapper around ``OrderTrackingFeature``. The same
/// reducer drives both **active** orders (full live tracking with map +
/// driver + ETA + realtime updates) and **terminal** orders (read-only
/// receipt + reorder CTA). Status-conditional UI is the view's job; the
/// reducer just composes the tracking child and adds the reorder
/// delegate.
///
/// The "active vs completed" choice is computed from the underlying
/// order's `OrderStatus.isTerminal` — see ``State/canReorder`` and
/// ``State/isTerminal``. There is intentionally no separate read-only
/// reducer; the tracking subscription is harmless on a delivered order
/// (it'll receive zero realtime events) and the rating timer only fires
/// when the status flips to `.delivered` *during* the session, never on
/// pre-loaded terminal orders.
@Reducer
public struct OrderDetailFeature: Sendable {
  @ObservableState
  public struct State: Equatable, Sendable {
    /// Composed tracking child — owns the order, events, driver, and
    /// realtime subscription. Mounted at the same `orderId` the parent
    /// passed in.
    public var tracking: OrderTrackingFeature.State

    public init(orderId: UUID) {
      self.tracking = OrderTrackingFeature.State(orderId: orderId)
    }

    public init(tracking: OrderTrackingFeature.State) {
      self.tracking = tracking
    }

    public var orderId: UUID { tracking.orderId }

    /// True when the order has reached a terminal state. The view uses
    /// this to swap the tracking timeline for a receipt layout.
    public var isTerminal: Bool {
      tracking.order?.status.isTerminal ?? false
    }

    /// True when the "Reorder" CTA should be live. We only allow
    /// reorder on `.delivered` (not on cancellations / disputes) since
    /// those terminal states don't represent a successful purchase
    /// pattern worth recreating.
    public var canReorder: Bool {
      tracking.order?.status == .delivered
    }
  }

  public enum Action: Sendable {
    case tracking(OrderTrackingFeature.Action)
    case reorderTapped

    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Sendable, Equatable {
      /// Emitted when the user taps "Reorder" on a delivered order.
      /// The parent (Browse) seeds a fresh local cart draft from the
      /// order's `items[]` and switches to the Cart tab.
      case reorderRequested(orderId: UUID)
    }
  }

  public init() {}

  public var body: some ReducerOf<Self> {
    Scope(state: \.tracking, action: \.tracking) {
      OrderTrackingFeature()
    }

    Reduce { state, action in
      switch action {
      case .reorderTapped:
        guard state.canReorder else { return .none }
        return .send(.delegate(.reorderRequested(orderId: state.orderId)))

      case .tracking, .delegate:
        return .none
      }
    }
  }
}
