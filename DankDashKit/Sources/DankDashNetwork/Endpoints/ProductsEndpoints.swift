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
}
