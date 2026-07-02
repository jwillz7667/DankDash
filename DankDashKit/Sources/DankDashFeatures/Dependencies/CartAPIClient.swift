import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// `@DependencyClient`-style abstraction over the cart endpoints
/// (`POST /v1/carts`, item add/patch/remove, validate, delete). The
/// reducer depends on this struct rather than `APIClient` so TestStore
/// tests substitute typed closures without touching URLSession.
///
/// Each closure projects the wire DTO into Domain at the boundary —
/// a malformed cart payload throws `CartAPIError.malformedPayload` so
/// the reducer never has to consider DTO-typed state.
public struct CartAPIClient: Sendable {
  public var createCart: @Sendable (UUID) async throws -> Cart
  public var getCart: @Sendable (UUID) async throws -> Cart
  public var addItem: @Sendable (UUID, UUID, Int) async throws -> Cart
  public var patchItem: @Sendable (UUID, UUID, Int) async throws -> Cart
  public var removeItem: @Sendable (UUID, UUID) async throws -> Cart
  public var validate: @Sendable (UUID, UUID) async throws -> ComplianceEvaluation
  public var deleteCart: @Sendable (UUID) async throws -> Void
  /// Applies a promo code to the cart; throws ``CartAPIError/promo`` with
  /// the server's user-facing message on a `PROMO_*` rejection.
  public var applyPromo: @Sendable (UUID, String) async throws -> Cart
  /// Removes any applied promo code and returns the reset cart.
  public var removePromo: @Sendable (UUID) async throws -> Cart

  public init(
    createCart: @Sendable @escaping (UUID) async throws -> Cart,
    getCart: @Sendable @escaping (UUID) async throws -> Cart,
    addItem: @Sendable @escaping (UUID, UUID, Int) async throws -> Cart,
    patchItem: @Sendable @escaping (UUID, UUID, Int) async throws -> Cart,
    removeItem: @Sendable @escaping (UUID, UUID) async throws -> Cart,
    validate: @Sendable @escaping (UUID, UUID) async throws -> ComplianceEvaluation,
    deleteCart: @Sendable @escaping (UUID) async throws -> Void,
    applyPromo: @Sendable @escaping (UUID, String) async throws -> Cart,
    removePromo: @Sendable @escaping (UUID) async throws -> Cart
  ) {
    self.createCart = createCart
    self.getCart = getCart
    self.addItem = addItem
    self.patchItem = patchItem
    self.removeItem = removeItem
    self.validate = validate
    self.deleteCart = deleteCart
    self.applyPromo = applyPromo
    self.removePromo = removePromo
  }
}

public extension CartAPIClient {
  /// Production binding. Each closure routes through the shared
  /// `APIClient` so the bearer-injection / 401-refresh behavior applies
  /// uniformly. Failable `.toDomain()` projections throw `CartAPIError`
  /// on structurally invalid payloads.
  static func live(apiClient: APIClient) -> CartAPIClient {
    CartAPIClient(
      createCart: { dispensaryId in
        let dto = try await apiClient.send(CartEndpoints.createCart(dispensaryId: dispensaryId))
        guard let cart = dto.toDomain() else { throw CartAPIError.malformedPayload("Cart") }
        return cart
      },
      getCart: { cartId in
        let dto = try await apiClient.send(CartEndpoints.getCart(cartId: cartId))
        guard let cart = dto.toDomain() else { throw CartAPIError.malformedPayload("Cart") }
        return cart
      },
      addItem: { cartId, listingId, quantity in
        let body = AddCartItemRequestDTO(listingId: listingId, quantity: quantity)
        let dto = try await apiClient.send(CartEndpoints.addItem(cartId: cartId, body: body))
        guard let cart = dto.toDomain() else { throw CartAPIError.malformedPayload("Cart") }
        return cart
      },
      patchItem: { cartId, itemId, quantity in
        let body = PatchCartItemRequestDTO(quantity: quantity)
        let dto = try await apiClient.send(
          CartEndpoints.patchItem(cartId: cartId, itemId: itemId, body: body)
        )
        guard let cart = dto.toDomain() else { throw CartAPIError.malformedPayload("Cart") }
        return cart
      },
      removeItem: { cartId, itemId in
        let dto = try await apiClient.send(
          CartEndpoints.removeItem(cartId: cartId, itemId: itemId)
        )
        guard let cart = dto.toDomain() else { throw CartAPIError.malformedPayload("Cart") }
        return cart
      },
      validate: { cartId, deliveryAddressId in
        let dto = try await apiClient.send(
          CartEndpoints.validate(cartId: cartId, deliveryAddressId: deliveryAddressId)
        )
        guard let evaluation = dto.toDomain() else {
          throw CartAPIError.malformedPayload("ComplianceEvaluation")
        }
        return evaluation
      },
      deleteCart: { cartId in
        _ = try await apiClient.send(CartEndpoints.deleteCart(cartId: cartId))
      },
      applyPromo: { cartId, code in
        do {
          let body = ApplyPromoRequestDTO(code: code)
          let dto = try await apiClient.send(CartEndpoints.applyPromo(cartId: cartId, body: body))
          guard let cart = dto.toDomain() else { throw CartAPIError.malformedPayload("Cart") }
          return cart
        } catch let error as APIError {
          throw CartAPIError.from(promoError: error)
        }
      },
      removePromo: { cartId in
        do {
          let dto = try await apiClient.send(CartEndpoints.removePromo(cartId: cartId))
          guard let cart = dto.toDomain() else { throw CartAPIError.malformedPayload("Cart") }
          return cart
        } catch let error as APIError {
          throw CartAPIError.from(promoError: error)
        }
      }
    )
  }

  /// Test fixture that always throws — surfaces "this dependency wasn't
  /// stubbed" in TestStore tests as a clear error.
  static let unimplemented = CartAPIClient(
    createCart: { _ in throw CartAPIError.unimplemented("createCart") },
    getCart: { _ in throw CartAPIError.unimplemented("getCart") },
    addItem: { _, _, _ in throw CartAPIError.unimplemented("addItem") },
    patchItem: { _, _, _ in throw CartAPIError.unimplemented("patchItem") },
    removeItem: { _, _ in throw CartAPIError.unimplemented("removeItem") },
    validate: { _, _ in throw CartAPIError.unimplemented("validate") },
    deleteCart: { _ in throw CartAPIError.unimplemented("deleteCart") },
    applyPromo: { _, _ in throw CartAPIError.unimplemented("applyPromo") },
    removePromo: { _ in throw CartAPIError.unimplemented("removePromo") }
  )
}

public enum CartAPIError: Error, Sendable, Equatable {
  case malformedPayload(String)
  case unimplemented(String)
  /// A promo mutation the server rejected. `code` is the machine code
  /// (e.g. `PROMO_NOT_FOUND`); `message` is the server's user-facing text,
  /// surfaced inline near the promo field.
  case promo(code: String, message: String)
}

extension CartAPIError: LocalizedError {
  public var errorDescription: String? {
    switch self {
    case .malformedPayload(let label): "Couldn't read the \(label) response. Please try again."
    case .unimplemented(let name): "\(name) is not implemented."
    case .promo(_, let message): message
    }
  }
}

extension CartAPIError {
  /// Projects a transport-layer ``APIError`` into a promo-scoped error. A
  /// server envelope (any status — the contract uses 422) surfaces its
  /// message verbatim so the reducer can render it inline; every other
  /// failure keeps a generic, user-safe fallback rather than leaking
  /// transport internals into the promo field.
  static func from(promoError error: APIError) -> CartAPIError {
    switch error {
    case .server(_, let envelope):
      .promo(code: envelope.error.code, message: envelope.error.message)
    case .transport:
      .promo(code: "PROMO_TRANSPORT", message: "Couldn't reach DankDash. Check your connection and try again.")
    case .unauthorized, .noRefreshToken:
      .promo(code: "PROMO_UNAUTHORIZED", message: "Sign in again to apply a promo code.")
    case .unexpectedStatus, .decoding, .configuration:
      .promo(code: "PROMO_UNKNOWN", message: "Couldn't apply that promo code. Please try again.")
    }
  }
}

private enum CartAPIClientKey: DependencyKey {
  static let liveValue: CartAPIClient = .unimplemented
  static let testValue: CartAPIClient = .unimplemented
}

public extension DependencyValues {
  var cartAPIClient: CartAPIClient {
    get { self[CartAPIClientKey.self] }
    set { self[CartAPIClientKey.self] = newValue }
  }
}
