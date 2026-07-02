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

  /// Great-circle (haversine) distance to `other`, in meters. Pure math —
  /// no CoreLocation dependency, so the Domain stays framework-free and the
  /// result is deterministic in tests. Accurate to well within a meter at
  /// the sub-kilometer distances this is used for (movement thresholds).
  public func distanceMeters(to other: Coordinate) -> Double {
    let earthRadiusMeters = 6_371_000.0
    let lat1 = latitude * .pi / 180
    let lat2 = other.latitude * .pi / 180
    let dLat = (other.latitude - latitude) * .pi / 180
    let dLng = (other.longitude - longitude) * .pi / 180
    let a =
      sin(dLat / 2) * sin(dLat / 2)
      + cos(lat1) * cos(lat2) * sin(dLng / 2) * sin(dLng / 2)
    let c = 2 * atan2(sqrt(a), sqrt(1 - a))
    return earthRadiusMeters * c
  }
}
