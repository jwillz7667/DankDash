import Foundation
import ComposableArchitecture
import DankDashStorage

/// `@DependencyClient`-style abstraction over ``CartIdStore``. Reducers
/// depend on this typed surface so TestStore tests can substitute fake
/// implementations without going through ``UserDefaults``.
///
/// The Phase 18 invariant is one cart per dispensary — the dispensary
/// id is the primary key and the cart id is the resolved value. The
/// store is keyed by dispensary id, not user id; on logout the caller
/// invokes `clearAll` before the next user signs in.
public struct CartIdStoreClient: Sendable {
  public var cartId: @Sendable (_ dispensaryId: UUID) async -> UUID?
  public var setCartId: @Sendable (_ cartId: UUID, _ dispensaryId: UUID) async -> Void
  public var clear: @Sendable (_ dispensaryId: UUID) async -> Void
  public var clearAll: @Sendable () async -> Void

  public init(
    cartId: @Sendable @escaping (_ dispensaryId: UUID) async -> UUID?,
    setCartId: @Sendable @escaping (_ cartId: UUID, _ dispensaryId: UUID) async -> Void,
    clear: @Sendable @escaping (_ dispensaryId: UUID) async -> Void,
    clearAll: @Sendable @escaping () async -> Void
  ) {
    self.cartId = cartId
    self.setCartId = setCartId
    self.clear = clear
    self.clearAll = clearAll
  }
}

public extension CartIdStoreClient {
  /// Production binding over ``CartIdStore``. UserDefaults reads/writes
  /// are synchronous; the async-shaped closures bridge for parity with
  /// the rest of the dependency surface.
  static func live(store: CartIdStore = CartIdStore()) -> CartIdStoreClient {
    CartIdStoreClient(
      cartId: { dispensaryId in
        store.cartId(forDispensaryId: dispensaryId)
      },
      setCartId: { cartId, dispensaryId in
        store.set(cartId: cartId, forDispensaryId: dispensaryId)
      },
      clear: { dispensaryId in
        store.clear(dispensaryId: dispensaryId)
      },
      clearAll: { store.clearAll() }
    )
  }

  /// Test fixture: reads always miss, writes/clears are no-ops. Reducer
  /// tests substitute closures backed by an in-memory dictionary when
  /// they need the cache to round-trip.
  static let unimplemented = CartIdStoreClient(
    cartId: { _ in nil },
    setCartId: { _, _ in },
    clear: { _ in },
    clearAll: {}
  )
}

private enum CartIdStoreClientKey: DependencyKey {
  static let liveValue: CartIdStoreClient = .live()
  static let testValue: CartIdStoreClient = .unimplemented
}

public extension DependencyValues {
  var cartIdStoreClient: CartIdStoreClient {
    get { self[CartIdStoreClientKey.self] }
    set { self[CartIdStoreClientKey.self] = newValue }
  }
}
