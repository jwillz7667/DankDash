import Foundation
import DankDashDomain

/// Flat `{ latitude, longitude }` form — the iOS picker composes
/// coordinates from a `CLLocationCoordinate2D` returned by MapKit, so
/// the wire matches the on-device shape and avoids a class of lng/lat
/// order mistakes. Distinct from `GeoPointDTO`'s GeoJSON tuple which
/// the catalog feed uses for store locations.
public struct UserAddressLocationDTO: Codable, Sendable, Equatable {
  public let latitude: Double
  public let longitude: Double

  public init(latitude: Double, longitude: Double) {
    self.latitude = latitude
    self.longitude = longitude
  }
}

/// Wire shape for `UserAddressResponseSchema`. Decoded stringly to
/// mirror the JSON; `toDomain()` is the only place that validates
/// UUIDs / timestamps / coordinate bounds.
public struct UserAddressResponseDTO: Decodable, Sendable, Equatable {
  public let id: String
  public let label: String?
  public let line1: String
  public let line2: String?
  public let city: String
  public let region: String
  public let postalCode: String
  public let country: String
  public let location: UserAddressLocationDTO
  public let isDefault: Bool
  public let isValidated: Bool
  public let validatedAt: String?
  public let deliveryInstructions: String?
  public let createdAt: String
  public let updatedAt: String

  public init(
    id: String,
    label: String?,
    line1: String,
    line2: String?,
    city: String,
    region: String,
    postalCode: String,
    country: String,
    location: UserAddressLocationDTO,
    isDefault: Bool,
    isValidated: Bool,
    validatedAt: String?,
    deliveryInstructions: String?,
    createdAt: String,
    updatedAt: String
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
}

public extension UserAddressResponseDTO {
  /// Lossy projection. Returns nil on malformed scalars; a single bad
  /// row in the list response is silently dropped by the caller via
  /// `compactMap`.
  func toDomain() -> UserAddress? {
    guard let parsedID = CatalogWire.parseUUID(id) else { return nil }
    guard let parsedCreated = CatalogWire.parseISO8601(createdAt) else { return nil }
    guard let parsedUpdated = CatalogWire.parseISO8601(updatedAt) else { return nil }
    let parsedValidatedAt: Date?
    if let validatedAt {
      guard let parsed = CatalogWire.parseISO8601(validatedAt) else { return nil }
      parsedValidatedAt = parsed
    } else {
      parsedValidatedAt = nil
    }
    return UserAddress(
      id: parsedID,
      label: label,
      line1: line1,
      line2: line2,
      city: city,
      region: region,
      postalCode: postalCode,
      country: country,
      location: Coordinate(latitude: location.latitude, longitude: location.longitude),
      isDefault: isDefault,
      isValidated: isValidated,
      validatedAt: parsedValidatedAt,
      deliveryInstructions: deliveryInstructions,
      createdAt: parsedCreated,
      updatedAt: parsedUpdated
    )
  }
}

/// Wire envelope for `GET /v1/addresses`. The server returns
/// non-deleted addresses, default first.
public struct ListAddressesResponseDTO: Decodable, Sendable, Equatable {
  public let addresses: [UserAddressResponseDTO]

  public init(addresses: [UserAddressResponseDTO]) {
    self.addresses = addresses
  }

  /// Projects to Domain, silently dropping any malformed row.
  public func toDomain() -> [UserAddress] {
    addresses.compactMap { $0.toDomain() }
  }
}

/// Body for `POST /v1/addresses`. Mirrors `CreateAddressRequestSchema`.
/// `setAsDefault: true` promotes the new row to the singleton default
/// in the same transaction (clears whatever row currently holds it);
/// the iOS picker sends true on the user's first address or when the
/// user explicitly toggled "save as default".
public struct CreateAddressRequestDTO: Encodable, Sendable, Equatable {
  public let label: String?
  public let line1: String
  public let line2: String?
  public let city: String
  public let region: String
  public let postalCode: String
  public let country: String
  public let latitude: Double
  public let longitude: Double
  public let deliveryInstructions: String?
  public let setAsDefault: Bool?

  public init(
    label: String? = nil,
    line1: String,
    line2: String? = nil,
    city: String,
    region: String,
    postalCode: String,
    country: String = "US",
    latitude: Double,
    longitude: Double,
    deliveryInstructions: String? = nil,
    setAsDefault: Bool? = nil
  ) {
    self.label = label
    self.line1 = line1
    self.line2 = line2
    self.city = city
    self.region = region
    self.postalCode = postalCode
    self.country = country
    self.latitude = latitude
    self.longitude = longitude
    self.deliveryInstructions = deliveryInstructions
    self.setAsDefault = setAsDefault
  }
}

/// Body for `PATCH /v1/addresses/:id`. Every field is optional; the
/// server requires at least one. `isDefault: true` flips the
/// singleton (server-side atomic swap); `isDefault: false` is rejected
/// because the only way to drop the default is to promote another row,
/// and leaving the user with no default breaks the cart-validate
/// preflight invariant.
///
/// `latitude` + `longitude` ship together: the server rejects a patch
/// that supplies one without the other (sending only one would corrupt
/// the validated coordinate pair).
public struct PatchAddressRequestDTO: Encodable, Sendable, Equatable {
  public let label: String?
  public let line1: String?
  public let line2: String?
  public let city: String?
  public let region: String?
  public let postalCode: String?
  public let country: String?
  public let latitude: Double?
  public let longitude: Double?
  public let deliveryInstructions: String?
  public let isDefault: Bool?

  public init(
    label: String? = nil,
    line1: String? = nil,
    line2: String? = nil,
    city: String? = nil,
    region: String? = nil,
    postalCode: String? = nil,
    country: String? = nil,
    latitude: Double? = nil,
    longitude: Double? = nil,
    deliveryInstructions: String? = nil,
    isDefault: Bool? = nil
  ) {
    self.label = label
    self.line1 = line1
    self.line2 = line2
    self.city = city
    self.region = region
    self.postalCode = postalCode
    self.country = country
    self.latitude = latitude
    self.longitude = longitude
    self.deliveryInstructions = deliveryInstructions
    self.isDefault = isDefault
  }

  /// Encodes only the present (non-nil) fields so an empty PATCH body
  /// doesn't ship every key as null — the server rejects the all-null
  /// shape with "at least one field must be provided".
  private enum CodingKeys: String, CodingKey {
    case label, line1, line2, city, region, postalCode, country
    case latitude, longitude, deliveryInstructions, isDefault
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encodeIfPresent(label, forKey: .label)
    try container.encodeIfPresent(line1, forKey: .line1)
    try container.encodeIfPresent(line2, forKey: .line2)
    try container.encodeIfPresent(city, forKey: .city)
    try container.encodeIfPresent(region, forKey: .region)
    try container.encodeIfPresent(postalCode, forKey: .postalCode)
    try container.encodeIfPresent(country, forKey: .country)
    try container.encodeIfPresent(latitude, forKey: .latitude)
    try container.encodeIfPresent(longitude, forKey: .longitude)
    try container.encodeIfPresent(deliveryInstructions, forKey: .deliveryInstructions)
    try container.encodeIfPresent(isDefault, forKey: .isDefault)
  }
}

/// Body for a full-form edit of an existing address. Targets the same
/// `PATCH /v1/addresses/:id` endpoint as ``PatchAddressRequestDTO`` but
/// carries the entire address rather than a sparse field set — the edit
/// screen always submits every field the user can see.
///
/// The encoder difference is the whole reason this is a distinct type:
/// ``PatchAddressRequestDTO`` uses `encodeIfPresent`, so a `nil`
/// optional is *omitted* — which can never *clear* a server-side value.
/// Here `label`, `line2`, and `deliveryInstructions` encode as explicit
/// JSON `null` when nil, so deleting the text in the edit form actually
/// persists the clear (the server's PATCH schema marks all three
/// `.nullable()`). The required fields (`line1`/`city`/`region`/
/// `postalCode`/`country`/`latitude`/`longitude`) are always present, so
/// the body satisfies both server refines — "at least one field" and
/// "latitude + longitude together".
///
/// `isDefault` is the lone `encodeIfPresent` field: the server rejects
/// `isDefault: false` (the only way to drop the default is to promote
/// another row), so the edit form sets it to `true` only when promoting
/// a non-default address and otherwise leaves it `nil` (omitted).
public struct EditAddressRequestDTO: Encodable, Sendable, Equatable {
  public let label: String?
  public let line1: String
  public let line2: String?
  public let city: String
  public let region: String
  public let postalCode: String
  public let country: String
  public let latitude: Double
  public let longitude: Double
  public let deliveryInstructions: String?
  public let isDefault: Bool?

  public init(
    label: String?,
    line1: String,
    line2: String?,
    city: String,
    region: String,
    postalCode: String,
    country: String = "US",
    latitude: Double,
    longitude: Double,
    deliveryInstructions: String?,
    isDefault: Bool? = nil
  ) {
    self.label = label
    self.line1 = line1
    self.line2 = line2
    self.city = city
    self.region = region
    self.postalCode = postalCode
    self.country = country
    self.latitude = latitude
    self.longitude = longitude
    self.deliveryInstructions = deliveryInstructions
    self.isDefault = isDefault
  }

  private enum CodingKeys: String, CodingKey {
    case label, line1, line2, city, region, postalCode, country
    case latitude, longitude, deliveryInstructions, isDefault
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    // `encode` (not `encodeIfPresent`) on the nullable fields: Optional's
    // Encodable conformance writes `encodeNil()` for `.none`, so a nil
    // here ships as JSON `null` and clears the column server-side.
    try container.encode(label, forKey: .label)
    try container.encode(line1, forKey: .line1)
    try container.encode(line2, forKey: .line2)
    try container.encode(city, forKey: .city)
    try container.encode(region, forKey: .region)
    try container.encode(postalCode, forKey: .postalCode)
    try container.encode(country, forKey: .country)
    try container.encode(latitude, forKey: .latitude)
    try container.encode(longitude, forKey: .longitude)
    try container.encode(deliveryInstructions, forKey: .deliveryInstructions)
    // Omit unless promoting — the server rejects `isDefault: false`.
    try container.encodeIfPresent(isDefault, forKey: .isDefault)
  }
}
