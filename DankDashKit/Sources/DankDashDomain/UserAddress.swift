import Foundation

/// One saved delivery address on the caller's account. Mirror of
/// `UserAddressResponse` (`GET /v1/addresses`).
///
/// `location` is the flat `{ latitude, longitude }` form — chosen over
/// GeoJSON `{ coordinates: [lng, lat] }` because the iOS picker
/// composes coordinates from a `CLLocationCoordinate2D` returned by
/// MapKit's on-device geocoder, and the flat shape avoids a class of
/// lng/lat order mistakes.
///
/// `isDefault` marks the single address the cart-validate / checkout
/// flow uses as the default selection. The server enforces
/// singleton-ness via the `user_addresses_one_default` unique partial
/// index — the client just reads the flag.
///
/// `isValidated` is true once Phase-8 server-side geocoding completed
/// successfully (address fell inside a serviceable polygon). Failing
/// addresses are still persisted (the user might add the dispensary
/// later, or a polygon may expand) and surface in the picker with an
/// inline "delivery not available" hint.
public struct UserAddress: Identifiable, Hashable, Sendable, Codable {
  public let id: UUID
  public let label: String?
  public let line1: String
  public let line2: String?
  public let city: String
  public let region: String
  public let postalCode: String
  public let country: String
  public let location: Coordinate
  public let isDefault: Bool
  public let isValidated: Bool
  public let validatedAt: Date?
  public let deliveryInstructions: String?
  public let createdAt: Date
  public let updatedAt: Date

  public init(
    id: UUID,
    label: String?,
    line1: String,
    line2: String?,
    city: String,
    region: String,
    postalCode: String,
    country: String,
    location: Coordinate,
    isDefault: Bool,
    isValidated: Bool,
    validatedAt: Date?,
    deliveryInstructions: String?,
    createdAt: Date,
    updatedAt: Date
  ) {
    self.id = id
    self.label = label
    self.line1 = line1
    self.line2 = line2
    self.city = city
    self.region = region
    self.postalCode = postalCode
    self.country = country
    self.location = location
    self.isDefault = isDefault
    self.isValidated = isValidated
    self.validatedAt = validatedAt
    self.deliveryInstructions = deliveryInstructions
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }

  /// One-line preview for the picker row: `line1`, optionally `line2`,
  /// then `city, region postalCode`. Empty / whitespace-only `line2`
  /// is skipped so the result is never "100 Main St, , Minneapolis,
  /// MN".
  public var oneLine: String {
    var parts: [String] = [line1]
    if let line2, !line2.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      parts.append(line2)
    }
    parts.append("\(city), \(region) \(postalCode)")
    return parts.joined(separator: ", ")
  }
}
