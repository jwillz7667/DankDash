import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures
import DankDashNetwork

/// Top-level post-auth surface — five bottom tabs (Feed / Search / Cart /
/// Orders / Account) plus the optional drill-down stack (Storefront →
/// Product Detail). The drill-down is presented as a SwiftUI navigation
/// destination off the Feed tab so back gestures work as expected.
///
/// Phase-18 additions:
///   • Cart tab swaps the placeholder ``CartTabView`` for the full
///     ``CartView`` (server-cart promotion + compliance + Safari CTA).
///   • The Safari hand-off sheet (``CheckoutSafariView``) is mounted at
///     this layer because ``BrowseFeature`` owns the `checkoutHandoff`
///     child — the cart's CTA only dispatches the delegate that
///     promotes it.
struct BrowseRootView: View {
  @Bindable var store: StoreOf<BrowseFeature>
  @Dependency(\.cdnBaseURL) private var cdnBaseURL

  var body: some View {
    TabView(
      selection: Binding(
        get: { store.selectedTab },
        set: { store.send(.tabSelected($0)) }
      )
    ) {
      NavigationStack {
        DispensaryFeedView(
          store: store.scope(state: \.feed, action: \.feed)
        )
        .navigationDestination(
          isPresented: Binding(
            get: { store.storefront != nil },
            set: { isPresented in
              if !isPresented { store.send(.storefrontDismissed) }
            }
          )
        ) {
          if let storefrontStore = store.scope(state: \.storefront, action: \.storefront) {
            StorefrontView(store: storefrontStore)
              .navigationDestination(
                isPresented: Binding(
                  get: { store.productDetail != nil },
                  set: { isPresented in
                    if !isPresented { store.send(.productDetailDismissed) }
                  }
                )
              ) {
                if let detailStore = store.scope(state: \.productDetail, action: \.productDetail) {
                  ProductDetailView(store: detailStore)
                }
              }
          }
        }
      }
      .tabItem { Label("Feed", systemImage: "house") }
      .tag(BrowseFeature.Tab.feed)

      NavigationStack {
        SearchView(
          store: store.scope(state: \.search, action: \.search)
        )
        .navigationDestination(
          isPresented: Binding(
            get: { store.productDetail != nil && store.selectedTab == .search },
            set: { isPresented in
              if !isPresented { store.send(.productDetailDismissed) }
            }
          )
        ) {
          if let detailStore = store.scope(state: \.productDetail, action: \.productDetail) {
            ProductDetailView(store: detailStore)
          }
        }
      }
      .tabItem { Label("Search", systemImage: "magnifyingglass") }
      .tag(BrowseFeature.Tab.search)

      NavigationStack {
        CartView(
          store: store.scope(state: \.cart, action: \.cart),
          cdnBaseURL: cdnBaseURL
        )
      }
      .tabItem {
        Label("Cart", systemImage: "bag")
      }
      .badge(cartBadge)
      .tag(BrowseFeature.Tab.cart)

      OrdersTabView(store: store)
        .tabItem { Label("Orders", systemImage: "shippingbox") }
        .tag(BrowseFeature.Tab.orders)

      AccountTabView(store: store)
        .tabItem { Label("Account", systemImage: "person.crop.circle") }
        .tag(BrowseFeature.Tab.account)
    }
    .tint(DankColor.primary)
    .overlay(alignment: .top) {
      if let toast = store.addedToCartToast {
        ToastView(message: toast)
          .padding(.top, DankSpacing.md)
          .transition(.move(edge: .top).combined(with: .opacity))
          .task(id: toast) {
            try? await Task.sleep(for: .seconds(2.5))
            store.send(.toastDismissed)
          }
      }
    }
    .animation(.easeInOut(duration: 0.2), value: store.addedToCartToast)
    .sheet(
      isPresented: Binding(
        get: { store.checkoutHandoff != nil },
        set: { isPresented in
          if !isPresented { store.send(.checkoutHandoffDismissed) }
        }
      )
    ) {
      if let handoffStore = store.scope(state: \.checkoutHandoff, action: \.checkoutHandoff) {
        CheckoutSafariView(store: handoffStore)
      }
    }
  }

  /// Badge for the Cart tab — counts unpromoted draft lines plus any
  /// server-cart items so the customer sees a single "items waiting"
  /// number across the promotion boundary.
  private var cartBadge: Int {
    let draftCount = store.cart.draft.totalQuantity
    let serverCount = store.cart.serverCart?.items.reduce(0) { $0 + $1.quantity } ?? 0
    return draftCount + serverCount
  }
}

private struct ToastView: View {
  let message: String

  var body: some View {
    Text(message)
      .font(DankFont.body.weight(.semibold))
      .foregroundStyle(DankColor.cream)
      .padding(.horizontal, DankSpacing.md)
      .padding(.vertical, DankSpacing.sm)
      .background(
        Capsule().fill(DankColor.primary.opacity(0.95))
      )
      .shadow(color: Color.black.opacity(0.15), radius: 6, y: 3)
      .accessibilityElement()
      .accessibilityLabel(message)
  }
}
