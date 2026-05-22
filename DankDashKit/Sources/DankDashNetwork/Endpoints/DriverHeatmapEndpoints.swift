import Foundation
import DankDashDomain

/// Driver demand-heatmap surface (Phase 8 deferred):
///
///   GET /v1/driver/heatmap?lat=&lng=&radius=
///
/// iOS calls this every 60s while online. The endpoint is documented as
/// deferred in Phase 19's PROGRESS.md — on 404 the iOS reducer renders
/// an empty overlay (no toast, no error state) and keeps polling so the
/// overlay lights up automatically once the backend ships.
///
/// `radius` defaults to ~5 miles (8 km) so a single call covers the
/// visible map region without paginating; the server caps response
/// size at ~150 cells which is well under the 60-FPS render budget.
public enum DriverHeatmapEndpoints {
  public static func getHeatmap(near coordinate: Coordinate, radiusMeters: Int = 8000) -> Endpoint<DemandHeatmapResponseDTO> {
    Endpoint(
      method: .GET,
      path: "v1/driver/heatmap",
      queryItems: [
        URLQueryItem(name: "lat", value: String(coordinate.latitude)),
        URLQueryItem(name: "lng", value: String(coordinate.longitude)),
        URLQueryItem(name: "radius", value: String(radiusMeters)),
      ],
      requiresAuth: true
    )
  }
}
