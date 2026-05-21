import Foundation
import ComposableArchitecture
import DankDashDomain

/// Parent reducer for the five browse tabs (Feed / Search / Cart /
/// Orders / Account) plus the drill-down stack (Storefront →
/// ProductDetail). Owns the Phase-18 ``CartFeature`` (which itself
/// holds the in-memory draft seed), the ``OrderHistoryFeature`` for
/// past orders, and two optional sheet-mounted children — the
/// ``CheckoutHandoffFeature`` for the Apple §10.4 Safari hand-off and
/// the ``OrderDetailFeature`` for tapping into a specific order.
///
/// Navigation is modeled as two optional child states layered on top of
/// the tab selection (`storefront?` and `productDetail?`); the Safari
/// hand-off and order-detail use the same optional-state pattern with
/// `.ifLet`. This sidesteps `StackState` boilerplate while keeping the
/// depth-2 navigation explicit and testable.
@Reducer
public struct BrowseFeature: Sendable {
  public enum Tab: String, CaseIterable, Hashable, Sendable {
    case feed
    case search
    case cart
    case orders
    case account
  }

  @ObservableState
  public struct State: Equatable, Sendable {
    public var selectedTab: Tab
    public var feed: DispensaryFeedFeature.State
    public var search: SearchFeature.State
    public var cart: CartFeature.State
    public var orderHistory: OrderHistoryFeature.State
    public var storefront: StorefrontFeature.State?
    public var productDetail: ProductDetailFeature.State?
    public var orderDetail: OrderDetailFeature.State?
    public var checkoutHandoff: CheckoutHandoffFeature.State?
    /// Renders the "Item added to cart" toast after a successful
    /// addToCart. Set when the cart accepts a line; the view
    /// auto-dismisses after a few seconds via `toastDismissed`.
    public var addedToCartToast: String?

    public init(
      selectedTab: Tab = .feed,
      feed: DispensaryFeedFeature.State = .init(),
      search: SearchFeature.State = .init(),
      cart: CartFeature.State = .init(),
      orderHistory: OrderHistoryFeature.State = .init(),
      storefront: StorefrontFeature.State? = nil,
      productDetail: ProductDetailFeature.State? = nil,
      orderDetail: OrderDetailFeature.State? = nil,
      checkoutHandoff: CheckoutHandoffFeature.State? = nil,
      addedToCartToast: String? = nil
    ) {
      self.selectedTab = selectedTab
      self.feed = feed
      self.search = search
      self.cart = cart
      self.orderHistory = orderHistory
      self.storefront = storefront
      self.productDetail = productDetail
      self.orderDetail = orderDetail
      self.checkoutHandoff = checkoutHandoff
      self.addedToCartToast = addedToCartToast
    }
  }

  public enum Action: Sendable {
    case tabSelected(Tab)
    case storefrontDismissed
    case productDetailDismissed
    case orderDetailDismissed
    case checkoutHandoffDismissed
    case toastDismissed

    /// External entry point for deep-link / hand-off completion: jumps
    /// to the Orders tab and pushes the detail screen for the given
    /// order. Used by ``RootFeature`` after `dankdash://order/complete`
    /// is parsed and consumed, and emitted internally when the Safari
    /// hand-off finishes successfully.
    case openOrderTracking(orderId: UUID)

    case feed(DispensaryFeedFeature.Action)
    case search(SearchFeature.Action)
    case cart(CartFeature.Action)
    case orderHistory(OrderHistoryFeature.Action)
    case storefront(StorefrontFeature.Action)
    case productDetail(ProductDetailFeature.Action)
    case orderDetail(OrderDetailFeature.Action)
    case checkoutHandoff(CheckoutHandoffFeature.Action)
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
      CartFeature()
    }

    Scope(state: \.orderHistory, action: \.orderHistory) {
      OrderHistoryFeature()
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

      case .orderDetailDismissed:
        state.orderDetail = nil
        return .none

      case .checkoutHandoffDismissed:
        state.checkoutHandoff = nil
        return .none

      case .toastDismissed:
        state.addedToCartToast = nil
        return .none

      case .openOrderTracking(let orderId):
        // Terminal happy path for Safari hand-off + cold-launch deep
        // links. Push the order detail, switch to the Orders tab, and
        // tear down the hand-off sheet if it's still mounted.
        state.checkoutHandoff = nil
        state.selectedTab = .orders
        state.orderDetail = OrderDetailFeature.State(orderId: orderId)
        return .none

      // MARK: Feed → Storefront

      case .feed(.delegate(.openDispensary(let dispensaryId))):
        state.storefront = StorefrontFeature.State(dispensaryId: dispensaryId)
        return .none

      case .feed:
        return .none

      // MARK: Storefront → ProductDetail

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

      // MARK: ProductDetail → Cart

      case .productDetail(.delegate(.addedToCart(
        let listingId,
        let productId,
        let productName,
        let brand,
        let priceCents,
        let maxAvailable
      ))):
        guard maxAvailable > 0 else { return .none }
        // The dispensary the draft belongs to is fixed by the first
        // line. Switching dispensaries mid-draft clears the existing
        // lines — the proper "Switch dispensaries?" confirmation lives
        // in the cart view (C20); the reducer's job is to keep the
        // draft self-consistent so promotion against the server can
        // succeed.
        let detailDispensaryId = state.productDetail?.dispensaryId
        if let currentDispensaryId = state.cart.dispensaryId,
           let detailDispensaryId,
           currentDispensaryId != detailDispensaryId {
          state.cart.draft = LocalCartDraft()
          state.cart.serverCart = nil
          state.cart.evaluation = nil
        }
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
        if let detailDispensaryId {
          state.cart.dispensaryId = detailDispensaryId
        }
        state.addedToCartToast = "\(productName) added to cart"
        return .none

      case .productDetail(.delegate(.openRelatedProduct(let productId))):
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

      // MARK: Cart → Checkout hand-off

      case .cart(.delegate(.checkoutRequested(let cartId, let deliveryAddressId))):
        state.checkoutHandoff = CheckoutHandoffFeature.State(
          cartId: cartId,
          deliveryAddressId: deliveryAddressId
        )
        return .none

      case .cart:
        return .none

      // MARK: Checkout hand-off → Order tracking

      case .checkoutHandoff(.delegate(.completed(let orderId))):
        // Post-checkout: the cart is consumed. The server has flipped
        // the cart row to fulfilled / archived; iOS clears its mirror
        // so a fresh draft can accumulate against a future dispensary
        // visit. Cleanup is folded into a single reduction (mirrors
        // ``openOrderTracking``) so the parent ends in a consistent
        // state without a chained follow-up action.
        state.cart = CartFeature.State()
        state.checkoutHandoff = nil
        state.selectedTab = .orders
        state.orderDetail = OrderDetailFeature.State(orderId: orderId)
        return .none

      case .checkoutHandoff(.delegate(.dismissed)):
        state.checkoutHandoff = nil
        return .none

      case .checkoutHandoff:
        return .none

      // MARK: Order history → detail / reorder

      case .orderHistory(.delegate(.openOrder(let orderId))):
        state.orderDetail = OrderDetailFeature.State(orderId: orderId)
        return .none

      case .orderHistory:
        return .none

      case .orderDetail(.delegate(.reorderRequested)):
        // Best-effort draft seeding: extract whatever product fields
        // the order's `productSnapshot` carries. Anything missing
        // falls back to a placeholder so the line still renders and
        // the user can adjust before re-validating; `maxAvailable`
        // defaults to the original ordered quantity since current
        // inventory is unknown until the next storefront load.
        guard let order = state.orderDetail?.tracking.order else {
          return .none
        }
        var draft = LocalCartDraft()
        for item in order.items {
          let snapshot = item.productSnapshot.object
          let productId = snapshot?["id"]?.string.flatMap(UUID.init(uuidString:)) ?? UUID()
          let name = snapshot?["name"]?.string ?? "Reorder item"
          let brand = snapshot?["brand"]?.string ?? ""
          draft.add(
            LocalCartDraft.Line(
              listingId: item.listingId,
              productId: productId,
              productName: name,
              brand: brand,
              priceCents: item.unitPriceCents,
              quantity: item.quantity,
              maxAvailable: max(item.quantity, 1)
            )
          )
        }
        state.cart = CartFeature.State(
          draft: draft,
          dispensaryId: order.dispensaryId
        )
        state.orderDetail = nil
        state.selectedTab = .cart
        return .none

      case .orderDetail:
        return .none
      }
    }
    .ifLet(\.storefront, action: \.storefront) {
      StorefrontFeature()
    }
    .ifLet(\.productDetail, action: \.productDetail) {
      ProductDetailFeature()
    }
    .ifLet(\.orderDetail, action: \.orderDetail) {
      OrderDetailFeature()
    }
    .ifLet(\.checkoutHandoff, action: \.checkoutHandoff) {
      CheckoutHandoffFeature()
    }
  }
}
