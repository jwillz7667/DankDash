import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashFeatures
import DankDashNetwork

/// Top-level post-auth surface — four bottom tabs (Feed / Search / Cart /
/// Account) plus the optional drill-down stack (Storefront → Product
/// Detail). The drill-down is presented as a SwiftUI navigation
/// destination off the Feed tab so back gestures work as expected.
struct BrowseRootView: View {
  @Bindable var store: StoreOf<BrowseFeature>
  let user: UserSummaryDTO?
  let onSignOut: () -> Void

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
        CartTabView(store: store.scope(state: \.cart, action: \.cart))
      }
      .tabItem {
        Label("Cart", systemImage: "bag")
      }
      .badge(store.cart.totalQuantity > 0 ? store.cart.totalQuantity : 0)
      .tag(BrowseFeature.Tab.cart)

      NavigationStack {
        AccountTabView(user: user, onSignOut: onSignOut)
      }
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
