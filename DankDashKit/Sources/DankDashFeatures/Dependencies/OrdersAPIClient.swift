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

  public init(
    listOrders: @Sendable @escaping (ListOrdersQuery) async throws -> OrderListPage,
    getOrder: @Sendable @escaping (UUID) async throws -> OrderDetail
  ) {
    self.listOrders = listOrders
    self.getOrder = getOrder
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

  public init(order: Order, events: [OrderEvent], driver: DriverPublicProfile?) {
    self.order = order
    self.events = events
    self.driver = driver
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
          driver: projection.driver
        )
      }
    )
  }

  /// Test fixture that always throws.
  static let unimplemented = OrdersAPIClient(
    listOrders: { _ in throw OrdersAPIError.unimplemented("listOrders") },
    getOrder: { _ in throw OrdersAPIError.unimplemented("getOrder") }
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
