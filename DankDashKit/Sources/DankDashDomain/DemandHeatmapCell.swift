import Foundation

/// One demand-heatmap cell — a single hex cell with a 0..1 demand score
/// the driver app overlays on the shift map. Mirrors the planned
/// `GET /v1/driver/heatmap` response shape (deferred backend work in
/// Phase 19; the iOS client tolerates a 404 gracefully).
///
/// `polygon` is the cell's hex corners in CCW order (closed-ring not
/// required — the SwiftUI overlay closes implicitly). `demandScore` is
/// a NUMERIC string on the wire parsed to `Decimal` via the project's
/// `NUMERIC_STRING` contract — never `Double`.
///
/// The cell renderer maps `demandScore` to a moss → amber → danger
/// gradient (low → high demand). Cells outside the visible map region
/// are not drawn even if present in the response.
public struct DemandHeatmapCell: Identifiable, Hashable, Sendable, Codable {
  public let cellId: String
  public let polygon: [Coordinate]
  public let demandScore: Decimal

  public init(
    cellId: String,
    polygon: [Coordinate],
    demandScore: Decimal
  ) {
    self.cellId = cellId
    self.polygon = polygon
    self.demandScore = demandScore
  }

  public var id: String { cellId }
}
