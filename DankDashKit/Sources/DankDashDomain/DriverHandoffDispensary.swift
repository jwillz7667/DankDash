import Foundation

/// The dispensary pickup view for the driver — the row the route maps
/// to its "pickup" pin. The latitude/longitude come off the dispensary's
/// PostGIS `location` column projected through the repository, NOT a
/// geocode of the address string, so we never disagree with the
/// dispensary's canonical coordinates.
public struct DriverHandoffDispensary: Identifiable, Sendable, Equatable, Hashable, Codable {
  public let id: UUID
  public let name: String
  public let addressLine1: String
  public let addressLine2: String?
  public let city: String
  public let region: String
  public let postalCode: String
  public let location: Coordinate
  public let phone: String?

  public init(
    id: UUID,
    name: String,
    addressLine1: String,
    addressLine2: String?,
    city: String,
    region: String,
    postalCode: String,
    location: Coordinate,
    phone: String?
  ) {
    self.id = id
    self.name = name
    self.addressLine1 = addressLine1
    self.addressLine2 = addressLine2
    self.city = city
    self.region = region
    self.postalCode = postalCode
    self.location = location
    self.phone = phone
  }

  /// One-line address string for the PickupCard header.
  public var oneLine: String {
    var parts: [String] = [addressLine1]
    if let line2 = addressLine2?.trimmingCharacters(in: .whitespacesAndNewlines), !line2.isEmpty {
      parts.append(line2)
    }
    parts.append("\(city), \(region) \(postalCode)")
    return parts.joined(separator: ", ")
  }
}
