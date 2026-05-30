import Foundation

public enum SearchEndpoints {
  /// `GET /v1/products/search`. The query bag is the iOS-facing
  /// equivalent of `SearchProductsQuerySchema` — it renders the URL
  /// query items via `query.queryItems`.
  public static func search(_ query: SearchProductsQuery) -> Endpoint<SearchProductsResponseDTO> {
    Endpoint(
      method: .GET,
      path: "v1/products/search",
      queryItems: query.queryItems,
      requiresAuth: false
    )
  }
}
