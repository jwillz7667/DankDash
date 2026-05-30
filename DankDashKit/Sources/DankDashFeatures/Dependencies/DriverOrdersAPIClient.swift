import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// `@DependencyClient`-style abstraction over the driver-self order
/// surface — `GET /v1/driver/orders/:id` + the two confirm POSTs. The
/// reducer for ``ActiveRouteFeature`` takes this dependency rather
/// than poking ``APIClient`` directly so tests can fixture the active
/// route bundle deterministically without spinning up a stub server.
///
/// All three closures project the wire DTO down to the
/// ``ActiveRoute`` domain bundle. A malformed projection short-circuits
/// to ``DriverAPIError/malformedPayload`` — the screen treats this as
/// fatal for that route and surfaces an error banner with a back-out
/// CTA (the alternative, partial state, would leave the driver
/// looking at a half-rendered map for an order the system is
/// uncertain about).
public struct DriverOrdersAPIClient: Sendable {
  public var getOrder: @Sendable (UUID) async throws -> ActiveRoute
  public var pickupConfirm: @Sendable (UUID, DriverPickupConfirmRequestDTO) async throws -> ActiveRoute
  public var deliveryConfirm: @Sendable (UUID, DriverDeliveryConfirmRequestDTO) async throws -> ActiveRoute

  public init(
    getOrder: @Sendable @escaping (UUID) async throws -> ActiveRoute,
    pickupConfirm: @Sendable @escaping (UUID, DriverPickupConfirmRequestDTO) async throws -> ActiveRoute,
    deliveryConfirm: @Sendable @escaping (UUID, DriverDeliveryConfirmRequestDTO) async throws -> ActiveRoute
  ) {
    self.getOrder = getOrder
    self.pickupConfirm = pickupConfirm
    self.deliveryConfirm = deliveryConfirm
  }
}

public extension DriverOrdersAPIClient {
  static func live(apiClient: APIClient) -> DriverOrdersAPIClient {
    DriverOrdersAPIClient(
      getOrder: { orderId in
        let dto = try await apiClient.send(DriverOrdersEndpoints.getOrder(id: orderId))
        guard let route = dto.toDomain() else {
          throw DriverAPIError.malformedPayload("DriverOrderDetail")
        }
        return route
      },
      pickupConfirm: { orderId, body in
        let dto = try await apiClient.send(
          DriverOrdersEndpoints.pickupConfirm(id: orderId, body: body)
        )
        guard let route = dto.toDomain() else {
          throw DriverAPIError.malformedPayload("DriverOrderDetail")
        }
        return route
      },
      deliveryConfirm: { orderId, body in
        let dto = try await apiClient.send(
          DriverOrdersEndpoints.deliveryConfirm(id: orderId, body: body)
        )
        guard let route = dto.toDomain() else {
          throw DriverAPIError.malformedPayload("DriverOrderDetail")
        }
        return route
      }
    )
  }

  static let unimplemented = DriverOrdersAPIClient(
    getOrder: { _ in throw DriverAPIError.unimplemented("getOrder") },
    pickupConfirm: { _, _ in throw DriverAPIError.unimplemented("pickupConfirm") },
    deliveryConfirm: { _, _ in throw DriverAPIError.unimplemented("deliveryConfirm") }
  )
}

private enum DriverOrdersAPIClientKey: DependencyKey {
  static let liveValue: DriverOrdersAPIClient = .unimplemented
  static let testValue: DriverOrdersAPIClient = .unimplemented
}

public extension DependencyValues {
  var driverOrdersAPIClient: DriverOrdersAPIClient {
    get { self[DriverOrdersAPIClientKey.self] }
    set { self[DriverOrdersAPIClientKey.self] = newValue }
  }
}
