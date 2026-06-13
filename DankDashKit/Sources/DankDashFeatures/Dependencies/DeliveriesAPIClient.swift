import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// Abstraction over the open-pool delivery endpoints
/// (`GET /v1/driver/deliveries/available`,
/// `POST /v1/driver/deliveries/:orderId/claim`). The read side is a
/// straight poll (no targeted offer, no countdown), so — unlike
/// ``DispatchOfferAPIClient`` + ``OfferSubscriptionClient`` — both halves
/// live on one client: the cadence is the same for list and the claim is
/// the natural follow-up tap.
///
/// `claim` returns the claimed order id on success. A 409
/// (`DRIVER_DELIVERY_ALREADY_CLAIMED`) means another driver won the race;
/// the caller maps that to a "another driver grabbed it" toast and drops
/// the pin (see ``DriverShiftFeature.ClaimErrorBox``).
public struct DeliveriesAPIClient: Sendable {
  public var list: @Sendable () async throws -> [AvailableDelivery]
  public var claim: @Sendable (UUID) async throws -> UUID

  public init(
    list: @Sendable @escaping () async throws -> [AvailableDelivery],
    claim: @Sendable @escaping (UUID) async throws -> UUID
  ) {
    self.list = list
    self.claim = claim
  }
}

public extension DeliveriesAPIClient {
  static func live(apiClient: APIClient) -> DeliveriesAPIClient {
    DeliveriesAPIClient(
      list: {
        let dto = try await apiClient.send(DriverDeliveriesEndpoints.availableDeliveries())
        // Drop individually-malformed rows rather than failing the whole
        // board — one bad snapshot shouldn't hide every claimable order.
        return dto.deliveries.compactMap { $0.toDomain() }
      },
      claim: { orderId in
        let dto = try await apiClient.send(DriverDeliveriesEndpoints.claimDelivery(orderId: orderId))
        guard let claimedId = UUID(uuidString: dto.orderId) else {
          throw DriverAPIError.malformedPayload("ClaimDeliveryResponse")
        }
        return claimedId
      }
    )
  }

  static let unimplemented = DeliveriesAPIClient(
    list: { throw DriverAPIError.unimplemented("listAvailableDeliveries") },
    claim: { _ in throw DriverAPIError.unimplemented("claimDelivery") }
  )
}

private enum DeliveriesAPIClientKey: DependencyKey {
  static let liveValue: DeliveriesAPIClient = .unimplemented
  static let testValue: DeliveriesAPIClient = .unimplemented
}

public extension DependencyValues {
  var deliveriesAPIClient: DeliveriesAPIClient {
    get { self[DeliveriesAPIClientKey.self] }
    set { self[DeliveriesAPIClientKey.self] = newValue }
  }
}
