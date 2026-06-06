import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// `@DependencyClient`-style abstraction over the orders endpoints
/// (`GET /v1/orders`, `GET /v1/orders/:id`). Reducers depend on this
/// struct rather than `APIClient` so TestStore tests substitute typed
/// closures.
///
/// The list closure projects directly to a tuple-like `OrderListPage`;
/// the detail closure projects to `OrderDetail` (order + events +
/// optional driver). Both throw `OrdersAPIError.malformedPayload` if
/// the order itself fails to project — the orders tab can't render
/// without the order row.
public struct OrdersAPIClient: Sendable {
  public var listOrders: @Sendable (ListOrdersQuery) async throws -> OrderListPage
  public var getOrder: @Sendable (UUID) async throws -> OrderDetail
  /// `POST /v1/orders/:id/rate`. Submits the post-delivery rating and
  /// projects the returned order. Throws `OrdersAPIError.malformedPayload`
  /// if the response order fails to project. The server upsert is
  /// idempotent on the order row, so a retry after a transient failure is
  /// safe.
  public var rateOrder: @Sendable (UUID, OrderRatingInput) async throws -> Order

  public init(
    listOrders: @Sendable @escaping (ListOrdersQuery) async throws -> OrderListPage,
    getOrder: @Sendable @escaping (UUID) async throws -> OrderDetail,
    rateOrder: @Sendable @escaping (UUID, OrderRatingInput) async throws -> Order
  ) {
    self.listOrders = listOrders
    self.getOrder = getOrder
    self.rateOrder = rateOrder
  }
}

/// Feature-facing input for ``OrdersAPIClient/rateOrder``. Mirrors the
/// server's `RateOrderRequestSchema`: every field optional, at least one
/// required. The consumer rating sheet populates `rating` + `review`; the
/// per-party scores exist for a future richer sheet. Lives on the client
/// (not the DTO) so the reducer state stays Domain-only.
public struct OrderRatingInput: Sendable, Equatable {
  public let rating: Int?
  public let review: String?
  public let driverRating: Int?
  public let dispensaryRating: Int?

  public init(
    rating: Int? = nil,
    review: String? = nil,
    driverRating: Int? = nil,
    dispensaryRating: Int? = nil
  ) {
    self.rating = rating
    self.review = review
    self.driverRating = driverRating
    self.dispensaryRating = dispensaryRating
  }
}

/// Query parameters for `listOrders`. Defaults to "all statuses,
/// server-chosen page size, first page" so the simplest call site is
/// `try await client.listOrders(.init())`.
public struct ListOrdersQuery: Sendable, Equatable {
  public let status: OrderListStatusFilter
  public let limit: Int?
  public let cursor: String?

  public init(
    status: OrderListStatusFilter = .all,
    limit: Int? = nil,
    cursor: String? = nil
  ) {
    self.status = status
    self.limit = limit
    self.cursor = cursor
  }
}

/// `status` filter as understood by the server. Encoded as the literal
/// `active|completed|all` strings — the iOS reducer doesn't keep the
/// 19-state enum buckets in sync because the server is authoritative on
/// what "active" means.
public enum OrderListStatusFilter: String, Sendable, Equatable, CaseIterable {
  case active
  case completed
  case all
}

/// Domain-shaped projection of `OrderListResponseDTO.Domain`. Lives on
/// the client (not the DTO) because the feature layer wants a stable
/// type to push through reducer state without importing `DankDashNetwork`.
public struct OrderListPage: Sendable, Equatable {
  public let items: [OrderListItem]
  public let nextCursor: String?

  public init(items: [OrderListItem], nextCursor: String?) {
    self.items = items
    self.nextCursor = nextCursor
  }
}

/// Domain-shaped projection of `OrderDetailResponseDTO.Domain`. Same
/// rationale as `OrderListPage` — feature layer never imports the DTO
/// type so the reducer state stays Domain-only.
public struct OrderDetail: Sendable, Equatable {
  public let order: Order
  public let events: [OrderEvent]
  public let driver: DriverPublicProfile?
  /// Display name of the pickup dispensary, used as the dispensary map
  /// pin's title.
  public let dispensaryName: String
  /// Pickup pin coordinate (the dispensary's storefront).
  public let dispensaryCoordinate: Coordinate
  /// Drop-off pin coordinate (the customer's delivery address, frozen at
  /// checkout). The map is gated on this being present in reducer state.
  public let dropoffCoordinate: Coordinate
  /// Human label for the drop-off pin (the address line-1).
  public let dropoffLabel: String

  public init(
    order: Order,
    events: [OrderEvent],
    driver: DriverPublicProfile?,
    dispensaryName: String,
    dispensaryCoordinate: Coordinate,
    dropoffCoordinate: Coordinate,
    dropoffLabel: String
  ) {
    self.order = order
    self.events = events
    self.driver = driver
    self.dispensaryName = dispensaryName
    self.dispensaryCoordinate = dispensaryCoordinate
    self.dropoffCoordinate = dropoffCoordinate
    self.dropoffLabel = dropoffLabel
  }
}

public extension OrdersAPIClient {
  /// Production binding. Each closure routes through the shared
  /// `APIClient` so the bearer-injection / 401-refresh behavior applies
  /// uniformly.
  static func live(apiClient: APIClient) -> OrdersAPIClient {
    OrdersAPIClient(
      listOrders: { query in
        let dto = try await apiClient.send(
          OrdersEndpoints.listOrders(
            status: query.status.rawValue,
            limit: query.limit,
            cursor: query.cursor
          )
        )
        let projection = dto.toDomain()
        return OrderListPage(items: projection.items, nextCursor: projection.nextCursor)
      },
      getOrder: { id in
        let dto = try await apiClient.send(OrdersEndpoints.getOrder(id: id))
        guard let projection = dto.toDomain() else {
          throw OrdersAPIError.malformedPayload("Order")
        }
        return OrderDetail(
          order: projection.order,
          events: projection.events,
          driver: projection.driver,
          dispensaryName: projection.dispensaryName,
          dispensaryCoordinate: projection.dispensaryCoordinate,
          dropoffCoordinate: projection.dropoffCoordinate,
          dropoffLabel: projection.dropoffLabel
        )
      },
      rateOrder: { id, input in
        let dto = try await apiClient.send(
          OrdersEndpoints.rateOrder(
            id: id,
            body: OrderRatingRequestDTO(
              rating: input.rating,
              review: input.review,
              driverRating: input.driverRating,
              dispensaryRating: input.dispensaryRating
            )
          )
        )
        guard let order = dto.toDomain() else {
          throw OrdersAPIError.malformedPayload("Order")
        }
        return order
      }
    )
  }

  /// Test fixture that always throws.
  static let unimplemented = OrdersAPIClient(
    listOrders: { _ in throw OrdersAPIError.unimplemented("listOrders") },
    getOrder: { _ in throw OrdersAPIError.unimplemented("getOrder") },
    rateOrder: { _, _ in throw OrdersAPIError.unimplemented("rateOrder") }
  )
}

public enum OrdersAPIError: Error, Sendable, Equatable {
  case malformedPayload(String)
  case unimplemented(String)
}

private enum OrdersAPIClientKey: DependencyKey {
  static let liveValue: OrdersAPIClient = .unimplemented
  static let testValue: OrdersAPIClient = .unimplemented
}

public extension DependencyValues {
  var ordersAPIClient: OrdersAPIClient {
    get { self[OrdersAPIClientKey.self] }
    set { self[OrdersAPIClientKey.self] = newValue }
  }
}
