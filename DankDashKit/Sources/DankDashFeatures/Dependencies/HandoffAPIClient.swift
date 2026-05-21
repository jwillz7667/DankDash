import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// `@DependencyClient`-style abstraction over the checkout-handoff
/// endpoint (`POST /v1/auth/checkout-handoff`). Sole purpose: trade a
/// `(cartId, deliveryAddressId)` pair for a one-shot JWT + the
/// fully-qualified Safari URL.
///
/// The handoff is the only path off iOS for purchase (Apple §10.4) —
/// iOS never composes the Safari URL itself, never calls the checkout
/// endpoint, never sees a payment surface.
public struct HandoffAPIClient: Sendable {
  public var createCheckoutHandoff: @Sendable (UUID, UUID) async throws -> HandoffToken

  public init(
    createCheckoutHandoff: @Sendable @escaping (UUID, UUID) async throws -> HandoffToken
  ) {
    self.createCheckoutHandoff = createCheckoutHandoff
  }
}

public extension HandoffAPIClient {
  /// Production binding.
  static func live(apiClient: APIClient) -> HandoffAPIClient {
    HandoffAPIClient(
      createCheckoutHandoff: { cartId, deliveryAddressId in
        let body = CheckoutHandoffRequestDTO(
          cartId: cartId,
          deliveryAddressId: deliveryAddressId
        )
        let dto = try await apiClient.send(
          AuthHandoffEndpoints.createCheckoutHandoff(body: body)
        )
        guard let token = dto.toDomain() else {
          throw HandoffAPIError.malformedPayload("HandoffToken")
        }
        return token
      }
    )
  }

  /// Test fixture that always throws.
  static let unimplemented = HandoffAPIClient(
    createCheckoutHandoff: { _, _ in
      throw HandoffAPIError.unimplemented("createCheckoutHandoff")
    }
  )
}

public enum HandoffAPIError: Error, Sendable, Equatable {
  case malformedPayload(String)
  case unimplemented(String)
}

private enum HandoffAPIClientKey: DependencyKey {
  static let liveValue: HandoffAPIClient = .unimplemented
  static let testValue: HandoffAPIClient = .unimplemented
}

public extension DependencyValues {
  var handoffAPIClient: HandoffAPIClient {
    get { self[HandoffAPIClientKey.self] }
    set { self[HandoffAPIClientKey.self] = newValue }
  }
}
