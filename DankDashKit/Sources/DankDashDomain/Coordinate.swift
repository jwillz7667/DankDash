import Foundation

/// A geographic point. Latitude in degrees north (WGS84), longitude in
/// degrees east. The server wire format is GeoJSON `[lng, lat]`; the
/// Domain stores both names spelled out so a future contributor can't
/// accidentally swap them.
public struct Coordinate: Hashable, Sendable, Codable {
  public let latitude: Double
  public let longitude: Double

  public init(latitude: Double, longitude: Double) {
    self.latitude = latitude
    self.longitude = longitude
  }
}
