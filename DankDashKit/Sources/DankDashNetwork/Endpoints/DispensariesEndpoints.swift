import Foundation

/// Dispensary endpoint catalog. The browse stack treats this as the
/// authoritative source for "what URL serves what" — feature reducers
/// never compose paths inline.
public enum DispensariesEndpoints {
  /// `GET /v1/dispensaries[?lat=&lng=]`. The server intersects MN
  /// statutory sale hours with each store's schedule and computes
  /// `isOpenNow` + `opensAt` for the caller, so the iOS client never
  /// re-derives them from the wire.
  public static func listDispensaries(
    near coordinate: (latitude: Double, longitude: Double)? = nil
  ) -> Endpoint<DispensaryListResponseDTO> {
    var query: [URLQueryItem] = []
    if let coordinate {
      query.append(URLQueryItem(name: "lat", value: String(coordinate.latitude)))
      query.append(URLQueryItem(name: "lng", value: String(coordinate.longitude)))
    }
    return Endpoint(
      method: .GET,
      path: "v1/dispensaries",
      queryItems: query,
      requiresAuth: false
    )
  }

  /// `GET /v1/dispensaries/:id`. 404 for non-active stores; the iOS
  /// client treats 404 as "this storefront has gone away" and pops
  /// back to the feed.
  public static func getDispensary(id: UUID) -> Endpoint<DispensaryDTO> {
    Endpoint(
      method: .GET,
      path: "v1/dispensaries/\(id.uuidString.lowercased())",
      requiresAuth: false
    )
  }

  /// `GET /v1/dispensaries/:id/menu`. Returns the listing-product join
  /// shape so the menu screen can render without an extra catalog
  /// round-trip per row.
  public static func getMenu(dispensaryId: UUID) -> Endpoint<MenuResponseDTO> {
    Endpoint(
      method: .GET,
      path: "v1/dispensaries/\(dispensaryId.uuidString.lowercased())/menu",
      requiresAuth: false
    )
  }
}
