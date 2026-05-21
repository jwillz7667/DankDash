import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures

/// Root of the Orders tab. Owns the navigation stack that hosts
/// ``OrderHistoryView`` and conditionally pushes ``OrderDetailView``
/// when ``BrowseFeature/State/orderDetail`` is non-nil.
///
/// The detail child can be pushed three ways:
///   • user taps a row in the history list (`OrderHistoryFeature` →
///     `.delegate(.openOrder)`),
///   • Safari hand-off completes (`CheckoutHandoffFeature` →
///     `.delegate(.completed(orderId))`),
///   • cold-launch deep link (`dankdash://order/complete?orderId=...`
///     parsed by ``RootFeature``).
///
/// All three paths set `state.orderDetail` on `BrowseFeature`, so the
/// view doesn't care which one fired.
struct OrdersTabView: View {
  @Bindable var store: StoreOf<BrowseFeature>

  var body: some View {
    NavigationStack {
      OrderHistoryView(
        store: store.scope(state: \.orderHistory, action: \.orderHistory)
      )
      .navigationDestination(
        isPresented: Binding(
          get: { store.orderDetail != nil },
          set: { isPresented in
            if !isPresented { store.send(.orderDetailDismissed) }
          }
        )
      ) {
        if let detailStore = store.scope(state: \.orderDetail, action: \.orderDetail) {
          OrderDetailView(store: detailStore)
        }
      }
    }
  }
}
