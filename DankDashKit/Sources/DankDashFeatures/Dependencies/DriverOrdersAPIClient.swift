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
  /// Pre-custody bail-out. Returns the canceled order's id (echoed by
  /// the server) rather than an ``ActiveRoute`` — after the transition
  /// the order belongs to dispatch again and the detail hydration would
  /// 404 for this driver by construction.
  public var cancelDelivery: @Sendable (UUID, DriverCancelDeliveryRequestDTO) async throws -> UUID
  public var depart: @Sendable (UUID, DriverDepartRequestDTO) async throws -> ActiveRoute
  public var arrive: @Sendable (UUID, DriverArriveRequestDTO) async throws -> ActiveRoute
  public var deliveryConfirm: @Sendable (UUID, DriverDeliveryConfirmRequestDTO) async throws -> ActiveRoute

  public init(
    getOrder: @Sendable @escaping (UUID) async throws -> ActiveRoute,
    pickupConfirm: @Sendable @escaping (UUID, DriverPickupConfirmRequestDTO) async throws -> ActiveRoute,
    cancelDelivery: @Sendable @escaping (UUID, DriverCancelDeliveryRequestDTO) async throws -> UUID,
    depart: @Sendable @escaping (UUID, DriverDepartRequestDTO) async throws -> ActiveRoute,
    arrive: @Sendable @escaping (UUID, DriverArriveRequestDTO) async throws -> ActiveRoute,
    deliveryConfirm: @Sendable @escaping (UUID, DriverDeliveryConfirmRequestDTO) async throws -> ActiveRoute
  ) {
    self.getOrder = getOrder
    self.pickupConfirm = pickupConfirm
    self.cancelDelivery = cancelDelivery
    self.depart = depart
    self.arrive = arrive
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
      cancelDelivery: { orderId, body in
        let dto = try await apiClient.send(
          DriverOrdersEndpoints.cancel(id: orderId, body: body)
        )
        guard let canceledId = UUID(uuidString: dto.orderId) else {
          throw DriverAPIError.malformedPayload("DriverCancelDelivery")
        }
        return canceledId
      },
      depart: { orderId, body in
        let dto = try await apiClient.send(
          DriverOrdersEndpoints.depart(id: orderId, body: body)
        )
        guard let route = dto.toDomain() else {
          throw DriverAPIError.malformedPayload("DriverOrderDetail")
        }
        return route
      },
      arrive: { orderId, body in
        let dto = try await apiClient.send(
          DriverOrdersEndpoints.arrive(id: orderId, body: body)
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
    cancelDelivery: { _, _ in throw DriverAPIError.unimplemented("cancelDelivery") },
    depart: { _, _ in throw DriverAPIError.unimplemented("depart") },
    arrive: { _, _ in throw DriverAPIError.unimplemented("arrive") },
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
