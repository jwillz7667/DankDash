import Foundation
import ComposableArchitecture
import DankDashNetwork

/// Closure-backed dependency for the checkout surface. Reducers consume
/// it via `@Dependency(\.checkoutAPIClient)`; the live binding is wired in
/// `AppEnvironment.prepareDependencies`.
///
/// Two calls:
///   - `capabilities` — reads the server's test-only payment-bypass flag.
///     Returns the bare `Bool` because the cart reducer only needs that
///     one bit to decide whether to show the in-app "place test order"
///     affordance.
///   - `checkout` — creates the order from the cart. Takes domain values
///     (so the reducer never touches a wire DTO) and returns the new
///     order's id for routing to the order-tracking screen.
public struct CheckoutAPIClient: Sendable {
  public var capabilities: @Sendable () async throws -> Bool
  public var checkout: @Sendable (_ cartId: UUID, _ deliveryAddressId: UUID, _ driverTipCents: Int)
    async throws -> UUID

  public init(
    capabilities: @Sendable @escaping () async throws -> Bool,
    checkout: @Sendable @escaping (_ cartId: UUID, _ deliveryAddressId: UUID, _ driverTipCents: Int)
      async throws -> UUID
  ) {
    self.capabilities = capabilities
    self.checkout = checkout
  }
}

public extension CheckoutAPIClient {
  static func live(apiClient: APIClient) -> CheckoutAPIClient {
    CheckoutAPIClient(
      capabilities: {
        try await apiClient.send(CheckoutEndpoints.capabilities()).paymentBypassEnabled
      },
      checkout: { cartId, deliveryAddressId, driverTipCents in
        let body = CheckoutRequestDTO(
          deliveryAddressId: deliveryAddressId,
          driverTipCents: driverTipCents
        )
        let response = try await apiClient.send(
          CheckoutEndpoints.checkout(cartId: cartId, body: body)
        )
        guard let orderId = response.orderId else {
          throw CheckoutAPIError.malformedResponse("order.id")
        }
        return orderId
      }
    )
  }

  static let unimplemented = CheckoutAPIClient(
    capabilities: { throw CheckoutAPIError.unimplemented("capabilities") },
    checkout: { _, _, _ in throw CheckoutAPIError.unimplemented("checkout") }
  )
}

public enum CheckoutAPIError: Error, Sendable, Equatable {
  case unimplemented(String)
  /// The server returned a 2xx whose body could not be projected — e.g. a
  /// `order.id` that is not a valid UUID. Distinct from a transport error
  /// so the reducer can surface "something went wrong" without retrying a
  /// request that already created (or didn't create) an order.
  case malformedResponse(String)
}

private enum CheckoutAPIClientKey: DependencyKey {
  static let liveValue: CheckoutAPIClient = .unimplemented
  static let testValue: CheckoutAPIClient = .unimplemented
}

public extension DependencyValues {
  var checkoutAPIClient: CheckoutAPIClient {
    get { self[CheckoutAPIClientKey.self] }
    set { self[CheckoutAPIClientKey.self] = newValue }
  }
}
