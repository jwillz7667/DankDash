import Foundation

/// Orders endpoint catalog. Two endpoints — list (paginated, filterable)
/// and detail (order + events + optional driver). Both require auth and
/// are scoped to the caller by RLS.
public enum OrdersEndpoints {
  /// `GET /v1/orders[?status=&limit=&cursor=]`. Cursor pagination keyed
  /// on `(placedAt, id)` so concurrent inserts don't shift the page
  /// window. `status` is one of `active|completed|all`; the server
  /// maps `active` to "not in a terminal state" so the iOS reducer
  /// doesn't need to keep the 19-state enum in sync with that bucket.
  public static func listOrders(
    status: String? = nil,
    limit: Int? = nil,
    cursor: String? = nil
  ) -> Endpoint<OrderListResponseDTO> {
    var query: [URLQueryItem] = []
    if let status {
      query.append(URLQueryItem(name: "status", value: status))
    }
    if let limit {
      query.append(URLQueryItem(name: "limit", value: String(limit)))
    }
    if let cursor {
      query.append(URLQueryItem(name: "cursor", value: cursor))
    }
    return Endpoint(
      method: .GET,
      path: "v1/orders",
      queryItems: query,
      requiresAuth: true
    )
  }

  /// `GET /v1/orders/:id`. Returns the single-screen refresh shape
  /// (`{ order, events, driver? }`) used by the tracking screen on
  /// `onAppear` and as the polling fallback when the realtime socket
  /// drops for >15s.
  public static func getOrder(id: UUID) -> Endpoint<OrderDetailResponseDTO> {
    Endpoint(
      method: .GET,
      path: "v1/orders/\(id.uuidString.lowercased())",
      requiresAuth: true
    )
  }
}
