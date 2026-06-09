import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// Closure-backed abstraction over the payment-methods endpoints
/// (`GET/POST/PATCH/DELETE /v1/payment-methods`). Reducers depend on this
/// struct rather than `APIClient` so TestStore tests substitute typed
/// closures.
///
/// `listPaymentMethods` silently drops malformed rows (one bad row
/// shouldn't black-hole the screen). `linkAeropay` and `setDefault` throw
/// `PaymentMethodAPIError.malformedPayload` when the single-row projection
/// fails — those call sites need the freshly-returned value. `linkAeropay`
/// takes no argument: the `returnUrl` is an app-config concern bound at the
/// composition root (see `AppEnvironment`), not something a reducer should
/// know. `deletePaymentMethod` resolves `Void` (the server replies 204).
public struct PaymentMethodAPIClient: Sendable {
  public var listPaymentMethods: @Sendable () async throws -> [PaymentMethod]
  public var linkAeropay: @Sendable () async throws -> AeropayLinkSession
  public var setDefault: @Sendable (UUID) async throws -> PaymentMethod
  public var deletePaymentMethod: @Sendable (UUID) async throws -> Void

  public init(
    listPaymentMethods: @Sendable @escaping () async throws -> [PaymentMethod],
    linkAeropay: @Sendable @escaping () async throws -> AeropayLinkSession,
    setDefault: @Sendable @escaping (UUID) async throws -> PaymentMethod,
    deletePaymentMethod: @Sendable @escaping (UUID) async throws -> Void
  ) {
    self.listPaymentMethods = listPaymentMethods
    self.linkAeropay = linkAeropay
    self.setDefault = setDefault
    self.deletePaymentMethod = deletePaymentMethod
  }
}

public extension PaymentMethodAPIClient {
  /// Production binding. `returnURL` is the absolute URL Aeropay redirects
  /// to after the user completes the hosted bank-link flow; it's injected
  /// here so the API surface stays agnostic about the consumer host.
  static func live(apiClient: APIClient, returnURL: URL) -> PaymentMethodAPIClient {
    PaymentMethodAPIClient(
      listPaymentMethods: {
        let dto = try await apiClient.send(PaymentMethodsEndpoints.listPaymentMethods())
        return dto.toDomain()
      },
      linkAeropay: {
        let body = LinkAeropayRequestDTO(returnUrl: returnURL.absoluteString)
        let dto = try await apiClient.send(PaymentMethodsEndpoints.linkAeropay(body: body))
        guard let session = dto.link.toDomain() else {
          throw PaymentMethodAPIError.malformedPayload("AeropayLinkSession")
        }
        return session
      },
      setDefault: { id in
        let dto = try await apiClient.send(
          PaymentMethodsEndpoints.setDefault(id: id, body: SetDefaultPaymentMethodRequestDTO())
        )
        guard let method = dto.paymentMethod.toDomain() else {
          throw PaymentMethodAPIError.malformedPayload("PaymentMethod")
        }
        return method
      },
      deletePaymentMethod: { id in
        // 204 No Content → EmptyResponse; we only care that it didn't throw.
        _ = try await apiClient.send(PaymentMethodsEndpoints.deletePaymentMethod(id: id))
      }
    )
  }

  /// Test fixture that always throws.
  static let unimplemented = PaymentMethodAPIClient(
    listPaymentMethods: { throw PaymentMethodAPIError.unimplemented("listPaymentMethods") },
    linkAeropay: { throw PaymentMethodAPIError.unimplemented("linkAeropay") },
    setDefault: { _ in throw PaymentMethodAPIError.unimplemented("setDefault") },
    deletePaymentMethod: { _ in throw PaymentMethodAPIError.unimplemented("deletePaymentMethod") }
  )
}

public enum PaymentMethodAPIError: Error, Sendable, Equatable {
  case malformedPayload(String)
  case unimplemented(String)
}

private enum PaymentMethodAPIClientKey: DependencyKey {
  static let liveValue: PaymentMethodAPIClient = .unimplemented
  static let testValue: PaymentMethodAPIClient = .unimplemented
}

public extension DependencyValues {
  var paymentMethodAPIClient: PaymentMethodAPIClient {
    get { self[PaymentMethodAPIClientKey.self] }
    set { self[PaymentMethodAPIClientKey.self] = newValue }
  }
}
