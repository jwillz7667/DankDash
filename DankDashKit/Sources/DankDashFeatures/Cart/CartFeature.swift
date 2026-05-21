import Foundation
import ComposableArchitecture
import DankDashDomain

/// Cart-tab reducer. Owns the full promotion pipeline (in-memory draft →
/// server cart → first compliance evaluation), the quantity-stepper /
/// remove surface against the server cart, the optional delivery address
/// selection, and the expiry countdown.
///
/// The Phase-17 ``LocalCartDraftFeature`` remains as a transient seed
/// outside this reducer: when the user enters the cart tab with a
/// non-empty draft and no server cart, CartFeature creates a server
/// cart, drains the draft into it (one `addItem` per line), and runs
/// the first `validate` against the user's default address. On
/// promotion success the local draft is cleared so subsequent
/// quantity edits go through the server cart only — the server cart
/// is the source of truth once it exists.
///
/// **Apple §10.4:** there is no checkout reducer in iOS. The CTA only
/// emits ``Action/Delegate/checkoutRequested`` which the parent routes
/// to ``CheckoutHandoffFeature`` for the Safari hand-off.
@Reducer
public struct CartFeature: Sendable {
  @ObservableState
  public struct State: Equatable, Sendable {
    /// Carry-over from the Phase-17 in-memory accumulator. Provided by
    /// the parent ``BrowseFeature`` so a "Add to cart" tap that landed
    /// before the Cart tab opened still seeds the promotion.
    public var draft: LocalCartDraft

    /// Dispensary the draft / cart belongs to. The Phase-18 invariant
    /// is one cart per dispensary; the parent surfaces this with the
    /// draft (lines always share a dispensary in the seed).
    public var dispensaryId: UUID?

    /// Server-cart projection. Mutations on the cart screen update this
    /// optimistically (quantity stepper, remove) and the debounced PATCH
    /// reconciles with the server payload once it lands.
    public var serverCart: Cart?

    /// Addresses available to the user. Populated by ``onAppear``;
    /// `selectedAddressId` defaults to the server-flagged default.
    public var availableAddresses: [UserAddress]
    public var selectedAddressId: UUID?
    public var isLoadingAddresses: Bool

    /// Latest compliance evaluation. Renders the three-bar compliance
    /// summary and gates the CTA on `passed`. Cleared whenever the cart
    /// mutates so the UI doesn't render a stale "all green" badge.
    public var evaluation: ComplianceEvaluation?

    /// Promotion is the multi-step "POST cart + N addItems + validate"
    /// sequence. While running, the cart screen shows a single spinner
    /// rather than partial states.
    public var isPromoting: Bool
    public var isValidating: Bool

    /// Recoverable error text — banner-rendered at the top of the cart
    /// screen. `nil` when the screen is in a healthy state.
    public var error: String?

    /// Seconds remaining until ``serverCart``'s `expiresAt` — drives
    /// the countdown banner. `nil` when there is no server cart yet.
    public var expirySecondsRemaining: Int?

    public init(
      draft: LocalCartDraft = LocalCartDraft(),
      dispensaryId: UUID? = nil,
      serverCart: Cart? = nil,
      availableAddresses: [UserAddress] = [],
      selectedAddressId: UUID? = nil,
      isLoadingAddresses: Bool = false,
      evaluation: ComplianceEvaluation? = nil,
      isPromoting: Bool = false,
      isValidating: Bool = false,
      error: String? = nil,
      expirySecondsRemaining: Int? = nil
    ) {
      self.draft = draft
      self.dispensaryId = dispensaryId
      self.serverCart = serverCart
      self.availableAddresses = availableAddresses
      self.selectedAddressId = selectedAddressId
      self.isLoadingAddresses = isLoadingAddresses
      self.evaluation = evaluation
      self.isPromoting = isPromoting
      self.isValidating = isValidating
      self.error = error
      self.expirySecondsRemaining = expirySecondsRemaining
    }

    /// Convenience selector — the picked address row, if any.
    public var selectedAddress: UserAddress? {
      guard let id = selectedAddressId else { return nil }
      return availableAddresses.first { $0.id == id }
    }

    /// Renders the "Continue to checkout" CTA enabled. Server-authoritative:
    /// every gate is a flag the server set or a state the user provided —
    /// no client-side re-computation of compliance.
    public var canCheckout: Bool {
      guard let serverCart, !serverCart.isEmpty else { return false }
      guard selectedAddressId != nil else { return false }
      guard let evaluation, evaluation.passed else { return false }
      return !isPromoting && !isValidating
    }
  }

  public enum Action: Sendable {
    case onAppear
    case onDisappear

    case addressesLoaded(Result<[UserAddress], EquatableError>)
    case selectAddress(UUID)

    case promotionRequested
    case cartCreated(Result<Cart, EquatableError>)
    case promotionFinished(Result<Cart, EquatableError>)

    case quantityStepped(itemId: UUID, quantity: Int)
    case syncCartFired(itemId: UUID, quantity: Int)
    case cartSynced(Result<Cart, EquatableError>)

    case validateRequested
    case validateFired
    case validationCompleted(Result<ComplianceEvaluation, EquatableError>)

    case expiryTimerStarted
    case expiryTick
    case cartExpired

    case checkoutTapped

    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Sendable, Equatable {
      case checkoutRequested(cartId: UUID, deliveryAddressId: UUID)
    }
  }

  // MARK: - Cancellation ids
  private enum CancelID: Hashable {
    case sync
    case validate
    case expiryTimer
  }

  // MARK: - Dependencies
  @Dependency(\.cartAPIClient) var cartAPIClient
  @Dependency(\.addressAPIClient) var addressAPIClient
  @Dependency(\.continuousClock) var clock
  @Dependency(\.date) var date

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .onAppear:
        var effects: [Effect<Action>] = [
          loadAddresses(),
          .send(.expiryTimerStarted)
        ]
        if shouldPromote(state) {
          effects.append(.send(.promotionRequested))
        }
        return .merge(effects)

      case .onDisappear:
        return .merge(
          .cancel(id: CancelID.sync),
          .cancel(id: CancelID.validate),
          .cancel(id: CancelID.expiryTimer)
        )

      case .addressesLoaded(.success(let addresses)):
        state.isLoadingAddresses = false
        state.availableAddresses = addresses
        if state.selectedAddressId == nil {
          state.selectedAddressId = addresses.first(where: \.isDefault)?.id ?? addresses.first?.id
        }
        return .none

      case .addressesLoaded(.failure(let error)):
        state.isLoadingAddresses = false
        state.error = error.message
        return .none

      case .selectAddress(let id):
        guard state.availableAddresses.contains(where: { $0.id == id }) else { return .none }
        state.selectedAddressId = id
        guard state.serverCart != nil else { return .none }
        return .send(.validateRequested)

      // MARK: Promotion

      case .promotionRequested:
        guard let dispensaryId = state.dispensaryId, !state.draft.isEmpty,
              state.serverCart == nil, !state.isPromoting else { return .none }
        state.isPromoting = true
        state.error = nil
        return promote(dispensaryId: dispensaryId, draft: state.draft, addressId: state.selectedAddressId)

      case .cartCreated(.success(let cart)):
        state.serverCart = cart
        state.expirySecondsRemaining = secondsUntil(cart.expiresAt)
        return .none

      case .cartCreated(.failure(let error)):
        state.isPromoting = false
        state.error = "Couldn't open a cart: \(error.message)"
        return .none

      case .promotionFinished(.success(let cart)):
        state.isPromoting = false
        state.serverCart = cart
        state.draft = LocalCartDraft()
        state.expirySecondsRemaining = secondsUntil(cart.expiresAt)
        if state.selectedAddressId != nil {
          return .send(.validateFired)
        }
        return .none

      case .promotionFinished(.failure(let error)):
        state.isPromoting = false
        state.error = error.message
        return .none

      // MARK: Quantity stepper

      case .quantityStepped(let itemId, let quantity):
        guard var cart = state.serverCart,
              let index = cart.items.firstIndex(where: { $0.id == itemId }) else {
          return .none
        }
        // Optimistic update so the stepper renders snappy. Server PATCH
        // round-trips replace the cart wholesale once it lands.
        if quantity <= 0 {
          cart = withItemRemoved(cart, at: index)
        } else {
          cart = withItemQuantity(cart, at: index, quantity: quantity)
        }
        state.serverCart = cart
        state.evaluation = nil
        return .run { [clock] send in
          try await clock.sleep(for: .milliseconds(350))
          await send(.syncCartFired(itemId: itemId, quantity: quantity))
        }
        .cancellable(id: CancelID.sync, cancelInFlight: true)

      case .syncCartFired(let itemId, let quantity):
        guard let cart = state.serverCart else { return .none }
        return .run { send in
          do {
            let updated: Cart
            if quantity <= 0 {
              updated = try await cartAPIClient.removeItem(cart.id, itemId)
            } else {
              updated = try await cartAPIClient.patchItem(cart.id, itemId, quantity)
            }
            await send(.cartSynced(.success(updated)))
          } catch {
            await send(.cartSynced(.failure(EquatableError(error))))
          }
        }

      case .cartSynced(.success(let cart)):
        state.serverCart = cart
        state.expirySecondsRemaining = secondsUntil(cart.expiresAt)
        return .send(.validateRequested)

      case .cartSynced(.failure(let error)):
        state.error = "Couldn't sync cart: \(error.message)"
        return .none

      // MARK: Validate

      case .validateRequested:
        return .run { [clock] send in
          try await clock.sleep(for: .milliseconds(350))
          await send(.validateFired)
        }
        .cancellable(id: CancelID.validate, cancelInFlight: true)

      case .validateFired:
        guard let cart = state.serverCart, let addressId = state.selectedAddressId else {
          return .none
        }
        state.isValidating = true
        return .run { send in
          do {
            let result = try await cartAPIClient.validate(cart.id, addressId)
            await send(.validationCompleted(.success(result)))
          } catch {
            await send(.validationCompleted(.failure(EquatableError(error))))
          }
        }
        .cancellable(id: CancelID.validate, cancelInFlight: true)

      case .validationCompleted(.success(let evaluation)):
        state.isValidating = false
        state.evaluation = evaluation
        return .none

      case .validationCompleted(.failure(let error)):
        state.isValidating = false
        state.error = "Couldn't validate cart: \(error.message)"
        return .none

      // MARK: Expiry

      case .expiryTimerStarted:
        return .run { send in
          for await _ in CartExpiryTimer.ticks(clock: clock) {
            await send(.expiryTick)
          }
        }
        .cancellable(id: CancelID.expiryTimer, cancelInFlight: true)

      case .expiryTick:
        guard let cart = state.serverCart else { return .none }
        let now = date.now
        if cart.expiresAt <= now {
          return .send(.cartExpired)
        }
        state.expirySecondsRemaining = secondsUntil(cart.expiresAt)
        return .none

      case .cartExpired:
        state.serverCart = nil
        state.evaluation = nil
        state.expirySecondsRemaining = nil
        state.error = "Your cart expired. Re-add items to continue."
        return .merge(
          .cancel(id: CancelID.sync),
          .cancel(id: CancelID.validate)
        )

      // MARK: Checkout

      case .checkoutTapped:
        guard state.canCheckout,
              let cart = state.serverCart,
              let addressId = state.selectedAddressId else { return .none }
        return .send(.delegate(.checkoutRequested(cartId: cart.id, deliveryAddressId: addressId)))

      case .delegate:
        return .none
      }
    }
  }

  // MARK: - Effect builders

  private func loadAddresses() -> Effect<Action> {
    .run { [addressAPIClient] send in
      do {
        let addresses = try await addressAPIClient.listAddresses()
        await send(.addressesLoaded(.success(addresses)))
      } catch {
        await send(.addressesLoaded(.failure(EquatableError(error))))
      }
    }
  }

  private func promote(
    dispensaryId: UUID,
    draft: LocalCartDraft,
    addressId: UUID?
  ) -> Effect<Action> {
    .run { [cartAPIClient] send in
      do {
        let cart = try await cartAPIClient.createCart(dispensaryId)
        await send(.cartCreated(.success(cart)))
        var updated = cart
        for line in draft.lines {
          updated = try await cartAPIClient.addItem(updated.id, line.listingId, line.quantity)
        }
        await send(.promotionFinished(.success(updated)))
      } catch {
        await send(.promotionFinished(.failure(EquatableError(error))))
      }
    }
  }

  private func shouldPromote(_ state: State) -> Bool {
    state.dispensaryId != nil && !state.draft.isEmpty && state.serverCart == nil && !state.isPromoting
  }

  private func secondsUntil(_ date: Date) -> Int {
    let now = self.date.now
    return max(0, Int(date.timeIntervalSince(now)))
  }

  private func withItemQuantity(_ cart: Cart, at index: Int, quantity: Int) -> Cart {
    var items = cart.items
    let line = items[index]
    items[index] = CartItem(
      id: line.id,
      listingId: line.listingId,
      quantity: quantity,
      unitPriceCents: line.unitPriceCents,
      lineSubtotalCents: line.unitPriceCents * quantity,
      createdAt: line.createdAt,
      updatedAt: line.updatedAt
    )
    return cart.with(items: items)
  }

  private func withItemRemoved(_ cart: Cart, at index: Int) -> Cart {
    var items = cart.items
    items.remove(at: index)
    return cart.with(items: items)
  }
}

// MARK: - Cart helpers

private extension Cart {
  func with(items: [CartItem]) -> Cart {
    Cart(
      id: id,
      userId: userId,
      dispensaryId: dispensaryId,
      items: items,
      subtotalCents: items.reduce(0) { $0 + $1.lineSubtotalCents },
      expiresAt: expiresAt,
      createdAt: createdAt,
      updatedAt: updatedAt
    )
  }
}

// MARK: - EquatableError

/// Type-erased error carrier with `Equatable` derived from the localized
/// description. TCA's `TestStore` requires `Equatable` actions; concrete
/// error types (URLError, decoding errors, our typed API errors) don't
/// guarantee that, and the reducer only ever reads the message anyway.
public struct EquatableError: Error, Equatable, Sendable {
  public let message: String

  public init(_ error: Error) {
    if let typed = error as? LocalizedError, let description = typed.errorDescription {
      self.message = description
    } else {
      self.message = String(describing: error)
    }
  }

  public init(message: String) {
    self.message = message
  }
}
