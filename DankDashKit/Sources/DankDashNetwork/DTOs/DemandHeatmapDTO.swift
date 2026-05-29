import Foundation
import DankDashDomain

/// Wire shape of one demand-heatmap cell. `polygon` is the cell's hex
/// corners as `[longitude, latitude]` tuples; the iOS mapper rejects
/// any cell whose ring has fewer than 3 coordinates (degenerate hex)
/// or any coordinate pair that isn't exactly two doubles. `demandScore`
/// flows as `NUMERIC_STRING` in 0...1 — cells with scores outside
/// that range are dropped rather than clamped because an out-of-range
/// score is server-side wrong, not just visually off.
public struct DemandHeatmapCellDTO: Decodable, Sendable, Equatable {
  public let cellId: String
  public let polygon: [[Double]]
  public let demandScore: String

  public init(cellId: String, polygon: [[Double]], demandScore: String) {
    self.cellId = cellId
    self.polygon = polygon
    self.demandScore = demandScore
  }
}

public extension DemandHeatmapCellDTO {
  func toDomain() -> DemandHeatmapCell? {
    guard !cellId.isEmpty else { return nil }
    guard polygon.count >= 3 else { return nil }
    guard let parsedScore = CatalogWire.parseDecimal(demandScore) else { return nil }
    if parsedScore < 0 || parsedScore > 1 { return nil }

    var ring: [Coordinate] = []
    ring.reserveCapacity(polygon.count)
    for pair in polygon {
      guard pair.count == 2 else { return nil }
      ring.append(Coordinate(latitude: pair[1], longitude: pair[0]))
    }
    return DemandHeatmapCell(cellId: cellId, polygon: ring, demandScore: parsedScore)
  }
}

/// Wire shape of `GET /v1/driver/heatmap`. The driver app polls every
/// 60s while online; the response carries the cells visible from the
/// current pin's view window. Empty `cells` is normal (e.g. driver is
/// in a low-demand suburb) and should render an empty overlay, not an
/// error toast.
public struct DemandHeatmapResponseDTO: Decodable, Sendable, Equatable {
  public let cells: [DemandHeatmapCellDTO]

  public init(cells: [DemandHeatmapCellDTO]) {
    self.cells = cells
  }
}

public extension DemandHeatmapResponseDTO {
  /// One malformed cell should not black-hole the whole overlay —
  /// drop bad cells silently and surface the rest.
  func toDomain() -> [DemandHeatmapCell] {
    cells.compactMap { $0.toDomain() }
  }
}
