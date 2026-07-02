import Foundation

/// Favorites endpoint catalog — the consumer's saved dispensaries + products
/// (`/v1/me/favorites`). All require auth and are scoped to the caller; PUT /
/// DELETE are idempotent (the server upserts/deletes and always replies 204),
/// so a retried heart-tap is safe.
public enum FavoritesEndpoints {
  /// `GET /v1/me/favorites` — one page of the reverse-chron feed, each save
  /// hydrated into a dispensary / product card summary.
  public static func listFavorites(limit: Int = 24, offset: Int = 0) -> Endpoint<FavoritesResponseDTO> {
    Endpoint(
      method: .GET,
      path: "v1/me/favorites",
      queryItems: [
        URLQueryItem(name: "limit", value: String(limit)),
        URLQueryItem(name: "offset", value: String(offset)),
      ],
      requiresAuth: true
    )
  }

  /// `PUT /v1/me/favorites/dispensaries/:id` — save a dispensary. 204.
  public static func addDispensary(id: UUID) -> Endpoint<EmptyResponse> {
    Endpoint(
      method: .PUT,
      path: "v1/me/favorites/dispensaries/\(id.uuidString.lowercased())",
      requiresAuth: true
    )
  }

  /// `DELETE /v1/me/favorites/dispensaries/:id` — unsave a dispensary. 204.
  public static func removeDispensary(id: UUID) -> Endpoint<EmptyResponse> {
    Endpoint(
      method: .DELETE,
      path: "v1/me/favorites/dispensaries/\(id.uuidString.lowercased())",
      requiresAuth: true
    )
  }

  /// `PUT /v1/me/favorites/products/:id` — save a product. 204.
  public static func addProduct(id: UUID) -> Endpoint<EmptyResponse> {
    Endpoint(
      method: .PUT,
      path: "v1/me/favorites/products/\(id.uuidString.lowercased())",
      requiresAuth: true
    )
  }

  /// `DELETE /v1/me/favorites/products/:id` — unsave a product. 204.
  public static func removeProduct(id: UUID) -> Endpoint<EmptyResponse> {
    Endpoint(
      method: .DELETE,
      path: "v1/me/favorites/products/\(id.uuidString.lowercased())",
      requiresAuth: true
    )
  }
}
