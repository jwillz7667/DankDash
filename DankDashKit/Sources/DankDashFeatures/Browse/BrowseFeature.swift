import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

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
    public var account: AccountFeature.State
    public var storefront: StorefrontFeature.State?
    public var productDetail: ProductDetailFeature.State?
    public var orderDetail: OrderDetailFeature.State?
    public var checkoutHandoff: CheckoutHandoffFeature.State?
    /// Renders the "Item added to cart" toast after a successful
    /// addToCart. Set when the cart accepts a line; the view
    /// auto-dismisses after a few seconds via `toastDismissed`.
    public var addedToCartToast: String?
    /// True while a product opened from search (or a related-product tile)
    /// is resolving its listing context — the view shows a spinner so the
    /// tap feels responsive during the one round-trip.
    public var isResolvingProduct: Bool
    /// User-facing message when a search drill-down can't resolve a
    /// buyable listing (no store carries it in stock, or the fetch failed).
    /// The view surfaces it as a transient toast and clears it via
    /// `productResolveErrorDismissed`.
    public var productResolveError: String?

    public init(
      selectedTab: Tab = .feed,
      feed: DispensaryFeedFeature.State = .init(),
      search: SearchFeature.State = .init(),
      cart: CartFeature.State = .init(),
      orderHistory: OrderHistoryFeature.State = .init(),
      account: AccountFeature.State = .init(),
      storefront: StorefrontFeature.State? = nil,
      productDetail: ProductDetailFeature.State? = nil,
      orderDetail: OrderDetailFeature.State? = nil,
      checkoutHandoff: CheckoutHandoffFeature.State? = nil,
      addedToCartToast: String? = nil,
      isResolvingProduct: Bool = false,
      productResolveError: String? = nil
    ) {
      self.selectedTab = selectedTab
      self.feed = feed
      self.search = search
      self.cart = cart
      self.orderHistory = orderHistory
      self.account = account
      self.storefront = storefront
      self.productDetail = productDetail
      self.orderDetail = orderDetail
      self.checkoutHandoff = checkoutHandoff
      self.addedToCartToast = addedToCartToast
      self.isResolvingProduct = isResolvingProduct
      self.productResolveError = productResolveError
    }
  }

  public enum Action: Sendable {
    case tabSelected(Tab)
    case storefrontDismissed
    case productDetailDismissed
    case orderDetailDismissed
    case checkoutHandoffDismissed
    case toastDismissed

    /// Result of resolving a product's listings after it was opened from
    /// search or a related-product tile. On success the reducer picks a
    /// listing (cart's current dispensary if it carries it, else cheapest)
    /// and pushes a fully-buyable ProductDetail.
    case productListingsResolved(
      productId: UUID,
      productName: String,
      brand: String,
      Result<[ProductListing], ProductResolveError>
    )
    case productResolveErrorDismissed

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
    case account(AccountFeature.Action)
    case storefront(StorefrontFeature.Action)
    case productDetail(ProductDetailFeature.Action)
    case orderDetail(OrderDetailFeature.Action)
    case checkoutHandoff(CheckoutHandoffFeature.Action)
    case delegate(Delegate)

    /// Surface for concerns the browse subtree can't own itself. Sign-out
    /// belongs to ``RootFeature`` (it clears tokens and resets the screen
    /// stack), so the Account tab routes its request up rather than
    /// mutating auth state from inside the tab.
    @CasePathable
    public enum Delegate: Equatable, Sendable {
      case signOutRequested
      /// Account deletion succeeded server-side; the root tears the session
      /// down (clear tokens, reset to signed-out) just like sign-out.
      case accountDeletionCompleted
    }
  }

  /// Failure modes when resolving a search hit's listings. The "no store
  /// carries this in stock" case is not an error here — the fetch succeeded
  /// with zero buyable rows, handled on the `.success` branch with a
  /// product-specific "unavailable" message.
  public enum ProductResolveError: Error, Sendable, Equatable {
    case transport
    case malformedPayload
    case unknown
  }

  @Dependency(\.catalogAPIClient) var catalogAPIClient

  /// Cancels an in-flight listing resolution when a new drill-down starts.
  private enum CancelID: Hashable, Sendable {
    case resolveProduct
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

    Scope(state: \.account, action: \.account) {
      AccountFeature()
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
            brand: item.product.brand,
            dispensaryName: state.storefront?.dispensary?.displayName
          )
        }
        return .none

      case .storefront:
        return .none

      case .search(.delegate(.openProduct(let productId))):
        // A search hit carries no listing (search is dispensary-agnostic).
        // Resolve the product's in-stock listings, then open a fully-buyable
        // ProductDetail against the chosen store. The hit already in the
        // search results supplies the name/brand for the title + toast.
        guard let hit = state.search.results.first(where: { $0.id == productId }) else {
          return .none
        }
        return resolveProductEffect(
          productId: productId,
          productName: hit.name,
          brand: hit.brand,
          state: &state
        )

      case .search:
        return .none

      case .productListingsResolved(let productId, let productName, let brand, .success(let listings)):
        state.isResolvingProduct = false
        // Prefer a listing at the cart's current dispensary so adding from
        // search doesn't needlessly clear an in-progress single-dispensary
        // draft; otherwise take the cheapest in-stock listing.
        guard let chosen = Self.chooseListing(
          listings,
          preferredDispensaryId: state.cart.dispensaryId
        ) else {
          state.productResolveError = "\(productName) is unavailable right now."
          return .none
        }
        state.productDetail = ProductDetailFeature.State(
          productId: productId,
          listingId: chosen.listingId,
          dispensaryId: chosen.dispensaryId,
          priceCents: chosen.priceCents,
          maxAvailable: chosen.quantityAvailable,
          productName: productName,
          brand: brand,
          dispensaryName: chosen.dispensaryName
        )
        return .none

      case .productListingsResolved(_, _, _, .failure(let error)):
        state.isResolvingProduct = false
        state.productResolveError = Self.resolveErrorMessage(for: error)
        return .none

      case .productResolveErrorDismissed:
        state.productResolveError = nil
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
        // Mirror catalog-level fields into the cart's productInfo so the
        // cart row can render brand / name after the draft is cleared on
        // promotion.
        state.cart.productInfo[listingId] = ListingProductInfo(
          name: productName,
          brand: brand
        )
        if let detailDispensaryId {
          state.cart.dispensaryId = detailDispensaryId
        }
        state.addedToCartToast = "\(productName) added to cart"
        return .none

      case .productDetail(.delegate(.openRelatedProduct(let productId))):
        // Related tiles are search hits too (no listing pin), so resolve
        // their listings the same way a search drill-down does rather than
        // opening an unbuyable detail. Name/brand come from the carousel row.
        guard let related = state.productDetail?.relatedProducts.first(where: { $0.id == productId })
        else {
          return .none
        }
        return resolveProductEffect(
          productId: productId,
          productName: related.name,
          brand: related.brand,
          state: &state
        )

      case .productDetail:
        return .none

      // MARK: Cart → Checkout hand-off

      case .cart(.delegate(.checkoutRequested(let cartId, let deliveryAddressId))):
        state.checkoutHandoff = CheckoutHandoffFeature.State(
          cartId: cartId,
          deliveryAddressId: deliveryAddressId
        )
        return .none

      case .cart(.delegate(.testOrderPlaced(let orderId))):
        // Test-mode bypass: the order was created in-app (no Safari
        // hand-off). Mirror the hand-off-completed cleanup — clear the
        // cart and route to the order-tracking screen.
        state.cart = CartFeature.State()
        state.selectedTab = .orders
        state.orderDetail = OrderDetailFeature.State(orderId: orderId)
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

      // MARK: Account → sign-out / cross-tab

      case .account(.delegate(.signOutRequested)):
        return .send(.delegate(.signOutRequested))

      case .account(.delegate(.accountDeletionCompleted)):
        return .send(.delegate(.accountDeletionCompleted))

      case .account(.delegate(.showOrders)):
        state.selectedTab = .orders
        return .none

      case .account:
        return .none

      case .delegate:
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
        var productInfo: [UUID: ListingProductInfo] = [:]
        for item in order.items {
          let snapshot = item.productSnapshot.object
          let productId = snapshot?["id"]?.string.flatMap(UUID.init(uuidString:)) ?? UUID()
          let name = snapshot?["name"]?.string ?? "Reorder item"
          let brand = snapshot?["brand"]?.string ?? ""
          let imageKey = snapshot?["imageKey"]?.string
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
          productInfo[item.listingId] = ListingProductInfo(
            name: name,
            brand: brand,
            imageKey: imageKey
          )
        }
        state.cart = CartFeature.State(
          draft: draft,
          dispensaryId: order.dispensaryId,
          productInfo: productInfo
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

  /// Flags the resolving state and fires the listings fetch. Shared by the
  /// search drill-down and the related-product tile — both open a product
  /// that carries no listing context and must resolve one before the
  /// ProductDetail can accept an add-to-cart.
  private func resolveProductEffect(
    productId: UUID,
    productName: String,
    brand: String,
    state: inout State
  ) -> Effect<Action> {
    state.isResolvingProduct = true
    state.productResolveError = nil
    return .run { send in
      do {
        let listings = try await catalogAPIClient.getProductListings(productId)
        await send(.productListingsResolved(
          productId: productId,
          productName: productName,
          brand: brand,
          .success(listings)
        ))
      } catch let error as CatalogAPIError {
        let mapped: ProductResolveError
        switch error {
        case .malformedPayload: mapped = .malformedPayload
        case .unimplemented: mapped = .unknown
        }
        await send(.productListingsResolved(
          productId: productId,
          productName: productName,
          brand: brand,
          .failure(mapped)
        ))
      } catch {
        await send(.productListingsResolved(
          productId: productId,
          productName: productName,
          brand: brand,
          .failure(.transport)
        ))
      }
    }
    .cancellable(id: CancelID.resolveProduct, cancelInFlight: true)
  }

  /// Deterministically picks the listing to open a search hit against. A
  /// listing at the cart's current dispensary wins so add-to-cart doesn't
  /// clear the single-dispensary draft; otherwise the cheapest in-stock
  /// listing, tie-broken by id so the choice is stable across fetches.
  static func chooseListing(
    _ listings: [ProductListing],
    preferredDispensaryId: UUID?
  ) -> ProductListing? {
    let available = listings.filter { $0.quantityAvailable > 0 }
    if let preferredDispensaryId,
       let match = available.first(where: { $0.dispensaryId == preferredDispensaryId }) {
      return match
    }
    return available.min { lhs, rhs in
      if lhs.priceCents != rhs.priceCents { return lhs.priceCents < rhs.priceCents }
      return lhs.listingId.uuidString < rhs.listingId.uuidString
    }
  }

  static func resolveErrorMessage(for error: ProductResolveError) -> String {
    switch error {
    case .transport: "We couldn't reach DankDash. Try again."
    case .malformedPayload: "Something didn't look right loading this product."
    case .unknown: "Something went wrong opening this product."
    }
  }
}
