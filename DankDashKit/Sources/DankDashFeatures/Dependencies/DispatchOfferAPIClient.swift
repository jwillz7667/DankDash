import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// `@DependencyClient`-style abstraction over the dispatch-offer
/// mutating endpoints (`POST /v1/driver/offers/:id/accept`,
/// `POST /v1/driver/offers/:id/decline`). Read-side offer subscription
/// (the polling fallback / `/driver` Socket.io namespace) lives in
/// ``OfferSubscriptionClient`` — kept separate because the read and
/// write halves have very different cadences and the offer card
/// reducer only ever takes a write-side dependency.
///
/// The 30-second acceptance window is a server contract: server
/// `dispatch_offers.expires_at` is the authoritative deadline. The
/// reducer ticks a local countdown for UX but does not race the
/// server — an accept-after-expiry surfaces as a 409 and routes to
/// the ``DispatchOfferFeature.OfferErrorBox.offerTaken`` case.
public struct DispatchOfferAPIClient: Sendable {
  public var accept: @Sendable (UUID) async throws -> DispatchOffer
  public var decline: @Sendable (UUID, String?) async throws -> DispatchOffer

  public init(
    accept: @Sendable @escaping (UUID) async throws -> DispatchOffer,
    decline: @Sendable @escaping (UUID, String?) async throws -> DispatchOffer
  ) {
    self.accept = accept
    self.decline = decline
  }
}

public extension DispatchOfferAPIClient {
  static func live(apiClient: APIClient) -> DispatchOfferAPIClient {
    DispatchOfferAPIClient(
      accept: { offerId in
        let dto = try await apiClient.send(DriverOffersEndpoints.acceptOffer(id: offerId))
        guard let offer = dto.toDomain() else {
          throw DriverAPIError.malformedPayload("DispatchOffer")
        }
        return offer
      },
      decline: { offerId, reason in
        let dto = try await apiClient.send(
          DriverOffersEndpoints.declineOffer(id: offerId, body: DeclineOfferRequestDTO(reason: reason))
        )
        guard let offer = dto.toDomain() else {
          throw DriverAPIError.malformedPayload("DispatchOffer")
        }
        return offer
      }
    )
  }

  static let unimplemented = DispatchOfferAPIClient(
    accept: { _ in throw DriverAPIError.unimplemented("acceptOffer") },
    decline: { _, _ in throw DriverAPIError.unimplemented("declineOffer") }
  )
}

private enum DispatchOfferAPIClientKey: DependencyKey {
  static let liveValue: DispatchOfferAPIClient = .unimplemented
  static let testValue: DispatchOfferAPIClient = .unimplemented
}

public extension DependencyValues {
  var dispatchOfferAPIClient: DispatchOfferAPIClient {
    get { self[DispatchOfferAPIClientKey.self] }
    set { self[DispatchOfferAPIClientKey.self] = newValue }
  }
}
