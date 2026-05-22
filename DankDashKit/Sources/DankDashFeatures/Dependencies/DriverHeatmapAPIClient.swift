import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// `@DependencyClient`-style abstraction over `GET /v1/driver/heatmap`.
///
/// The endpoint is documented as deferred for Phase 19 — the live
/// binding swallows a 404 and returns `[]` so the heatmap overlay
/// simply doesn't render until the backend lands. Other failures still
/// surface so reducers can decide whether to retry or back off.
public struct DriverHeatmapAPIClient: Sendable {
  public var getHeatmap: @Sendable (Coordinate, Int) async throws -> [DemandHeatmapCell]

  public init(
    getHeatmap: @Sendable @escaping (Coordinate, Int) async throws -> [DemandHeatmapCell]
  ) {
    self.getHeatmap = getHeatmap
  }

  /// Convenience overload using the default 5-mile (8000m) radius. The
  /// reducer always passes the driver's current coordinate, so this is
  /// the call site for ~95% of invocations.
  public func getHeatmap(near coordinate: Coordinate) async throws -> [DemandHeatmapCell] {
    try await getHeatmap(coordinate, 8_000)
  }
}

public extension DriverHeatmapAPIClient {
  static func live(apiClient: APIClient) -> DriverHeatmapAPIClient {
    DriverHeatmapAPIClient { coordinate, radius in
      do {
        let dto = try await apiClient.send(
          DriverHeatmapEndpoints.getHeatmap(near: coordinate, radiusMeters: radius)
        )
        return dto.toDomain()
      } catch let error as APIError {
        if case .server(let status, _) = error, status == 404 {
          return []
        }
        if case .unexpectedStatus(let status, _) = error, status == 404 {
          return []
        }
        throw error
      }
    }
  }

  static let unimplemented = DriverHeatmapAPIClient(
    getHeatmap: { _, _ in throw DriverAPIError.unimplemented("getHeatmap") }
  )
}

private enum DriverHeatmapAPIClientKey: DependencyKey {
  static let liveValue: DriverHeatmapAPIClient = .unimplemented
  static let testValue: DriverHeatmapAPIClient = .unimplemented
}

public extension DependencyValues {
  var driverHeatmapAPIClient: DriverHeatmapAPIClient {
    get { self[DriverHeatmapAPIClientKey.self] }
    set { self[DriverHeatmapAPIClientKey.self] = newValue }
  }
}
