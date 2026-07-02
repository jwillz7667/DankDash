import Foundation

public enum ProductsEndpoints {
  /// `GET /v1/products/:id`. Returns the full product with lab results
  /// sorted newest-first.
  public static func getProduct(id: UUID) -> Endpoint<ProductDTO> {
    Endpoint(
      method: .GET,
      path: "v1/products/\(id.uuidString.lowercased())",
      requiresAuth: false
    )
  }

  /// `GET /v1/products/:id/listings`. The stores actively carrying this
  /// product (in-stock), price-ascending, paginated. Used to resolve a
  /// concrete listing when a product is opened from search.
  public static func getProductListings(
    id: UUID,
    limit: Int = 50,
    offset: Int = 0
  ) -> Endpoint<ProductListingsResponseDTO> {
    Endpoint(
      method: .GET,
      path: "v1/products/\(id.uuidString.lowercased())/listings",
      queryItems: [
        URLQueryItem(name: "limit", value: String(limit)),
        URLQueryItem(name: "offset", value: String(offset)),
      ],
      requiresAuth: false
    )
  }
}
