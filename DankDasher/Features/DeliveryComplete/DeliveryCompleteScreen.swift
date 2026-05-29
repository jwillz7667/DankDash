import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures

/// SwiftUI shell for ``DeliveryCompleteFeature``. Wraps the design-
/// system ``DeliveryCompleteView`` and lets the reducer auto-fire the
/// `delivery-confirm` POST on `.onAppear`. Once the order transitions
/// to `delivered`, the reducer emits `.delegate(.completed)` and
/// ``DriverRootFeature`` pops the screen back to the shift home.
///
/// The view derives the payout estimate from the active route — driver
/// tip + delivery fee on the underlying order — because the canonical
/// payout breakdown only lands once the settlement worker has run. The
/// estimate is what the driver expects to see on their wallet next.
struct DeliveryCompleteScreen: View {
  @Bindable var store: StoreOf<DeliveryCompleteFeature>

  var body: some View {
    DeliveryCompleteView(
      customerDisplayName: store.route.customer.displayName,
      payoutEstimateCents: payoutEstimateCents,
      isConfirming: store.isConfirming,
      isCompleted: store.isDelivered,
      errorBanner: store.errorBanner,
      onBackToShift: { store.send(.doneTapped) },
      onRetry: { store.send(.retryTapped) }
    )
    .task { store.send(.onAppear) }
  }

  /// Driver's expected take from this delivery — sum of tip + delivery
  /// fee on the source order. The authoritative payout lands later in
  /// the wallet once the settlement worker breaks the order down into
  /// the `payments`/`payouts` rows; this is the at-handoff preview.
  private var payoutEstimateCents: Int {
    store.route.order.driverTipCents + store.route.order.deliveryFeeCents
  }
}
