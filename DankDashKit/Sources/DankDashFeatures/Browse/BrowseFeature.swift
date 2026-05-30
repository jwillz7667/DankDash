import Foundation
import ComposableArchitecture
import DankDashDomain

/// Parent reducer for the four browse tabs (Feed / Search / Cart /
/// Account) plus the drill-down stack (Storefront → ProductDetail).
/// Owns the single ``LocalCartDraftFeature`` so the cart-state visible
/// from the Cart tab and the "added" toast emitted from a ProductDetail
/// share one source of truth.
///
/// Navigation is modeled as two optional child states on the parent
/// (`storefront?` and `productDetail?`) layered on top of the tab
/// selection. A tap on a feed card sets `storefront`; a product tap
/// inside the storefront sets `productDetail`. Dismissals clear them in
/// reverse order. This sidesteps `StackState` boilerplate while keeping
/// the depth-2 navigation explicit and testable.
@Reducer
public struct BrowseFeature: Sendable {
  public enum Tab: String, CaseIterable, Hashable, Sendable {
    case feed
    case search
    case cart
    case account
  }

  @ObservableState
  public struct State: Equatable, Sendable {
    public var selectedTab: Tab
    public var feed: DispensaryFeedFeature.State
    public var search: SearchFeature.State
    public var cart: LocalCartDraftFeature.State
    public var storefront: StorefrontFeature.State?
    public var productDetail: ProductDetailFeature.State?
    /// Renders the "Item added to cart" toast after a successful
    /// addToCart. Set when the LocalCartDraft accepts a line; the view
    /// auto-dismisses after a few seconds via `toastDismissed`.
    public var addedToCartToast: String?

    public init(
      selectedTab: Tab = .feed,
      feed: DispensaryFeedFeature.State = .init(),
      search: SearchFeature.State = .init(),
      cart: LocalCartDraftFeature.State = .init(),
      storefront: StorefrontFeature.State? = nil,
      productDetail: ProductDetailFeature.State? = nil,
      addedToCartToast: String? = nil
    ) {
      self.selectedTab = selectedTab
      self.feed = feed
      self.search = search
      self.cart = cart
      self.storefront = storefront
      self.productDetail = productDetail
      self.addedToCartToast = addedToCartToast
    }
  }

  public enum Action: Sendable {
    case tabSelected(Tab)
    case storefrontDismissed
    case productDetailDismissed
    case toastDismissed
    case feed(DispensaryFeedFeature.Action)
    case search(SearchFeature.Action)
    case cart(LocalCartDraftFeature.Action)
    case storefront(StorefrontFeature.Action)
    case productDetail(ProductDetailFeature.Action)
  }

  public init() {}

  public var body: some ReducerOf<Self> {
    Scope(state: \.feed, action: \.feed) {
      DispensaryFeedFeature()
    }

    Scope(state: \.search, action: \.search) {
      SearchFeature()
    }

    Scope(state: \.cart, action: \.cart) {
      LocalCartDraftFeature()
    }

    Reduce { state, action in
      switch action {
      case .tabSelected(let tab):
        state.selectedTab = tab
        return .none

      case .storefrontDismissed:
        state.storefront = nil
        state.productDetail = nil
        return .none

      case .productDetailDismissed:
        state.productDetail = nil
        return .none

      case .toastDismissed:
        state.addedToCartToast = nil
        return .none

      case .feed(.delegate(.openDispensary(let dispensaryId))):
        state.storefront = StorefrontFeature.State(dispensaryId: dispensaryId)
        return .none

      case .feed:
        return .none

      case .storefront(.delegate(.openProduct(let productId, let listingId))):
        if let item = state.storefront?.menuItems.first(where: { $0.listingId == listingId }),
           let dispensaryId = state.storefront?.dispensaryId {
          state.productDetail = ProductDetailFeature.State(
            productId: productId,
            listingId: listingId,
            dispensaryId: dispensaryId,
            priceCents: item.priceCents,
            maxAvailable: item.quantityAvailable,
            productName: item.product.name,
            brand: item.product.brand
          )
        }
        return .none

      case .storefront:
        return .none

      case .search(.delegate(.openProduct(let productId))):
        // The search hit doesn't carry listing-level fields — without a
        // listing pin the cart can't accept the row, so the ProductDetail
        // surface launched from search renders with maxAvailable=0 and
        // the Add-to-cart button stays disabled.
        state.productDetail = ProductDetailFeature.State(
          productId: productId,
          listingId: UUID(),
          dispensaryId: UUID(),
          priceCents: 0,
          maxAvailable: 0,
          productName: "Product",
          brand: ""
        )
        return .none

      case .search:
        return .none

      case .productDetail(.delegate(.addedToCart(
        let listingId,
        let productId,
        let productName,
        let brand,
        let priceCents,
        let maxAvailable
      ))):
        // Mutate the cart in-place so the toast and the line both
        // observe inside the same store reduction — emitting a
        // follow-up `.cart` effect splits the change across two
        // reductions and complicates view + test code.
        guard maxAvailable > 0 else { return .none }
        state.cart.draft.add(
          LocalCartDraft.Line(
            listingId: listingId,
            productId: productId,
            productName: productName,
            brand: brand,
            priceCents: priceCents,
            quantity: 1,
            maxAvailable: maxAvailable
          )
        )
        state.addedToCartToast = "\(productName) added to cart"
        return .none

      case .productDetail(.delegate(.openRelatedProduct(let productId))):
        // Pop the current product detail; the storefront still has the
        // listing pin under it, but related products from a search hit
        // can't be added to the cart without a listing — degrade to a
        // disabled Add-to-cart by zeroing maxAvailable.
        if let current = state.productDetail {
          state.productDetail = ProductDetailFeature.State(
            productId: productId,
            listingId: current.listingId,
            dispensaryId: current.dispensaryId,
            priceCents: 0,
            maxAvailable: 0,
            productName: "Product",
            brand: ""
          )
        }
        return .none

      case .productDetail:
        return .none

      case .cart:
        return .none
      }
    }
    .ifLet(\.storefront, action: \.storefront) {
      StorefrontFeature()
    }
    .ifLet(\.productDetail, action: \.productDetail) {
      ProductDetailFeature()
    }
  }
}
