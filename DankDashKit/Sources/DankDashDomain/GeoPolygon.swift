import Foundation

/// A GeoJSON `Polygon` value. The outer ring describes the boundary; any
/// remaining rings are holes. Each ring is a closed loop — the first and
/// last `Coordinate` are equal — but Domain does not enforce that here;
/// the rendering layer is welcome to trust the server's shape.
public struct GeoPolygon: Hashable, Sendable, Codable {
  public let rings: [[Coordinate]]

  public init(rings: [[Coordinate]]) {
    self.rings = rings
  }

  public var outerRing: [Coordinate] {
    rings.first ?? []
  }

  public var holes: [[Coordinate]] {
    Array(rings.dropFirst())
  }
}
