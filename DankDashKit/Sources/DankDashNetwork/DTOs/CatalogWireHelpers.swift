import Foundation

/// Shared helpers for catalog-shaped wire payloads. Centralized here so
/// every catalog DTO uses the same UUID / ISO-8601 / Decimal / GeoJSON
/// parser — drift between mappers is the most common source of "this
/// works in tests but not in prod" bugs.
enum CatalogWire {
  /// Parses backend RFC-3339 timestamps. Tries the fractional-second
  /// variant first (NestJS / Zod emits microsecond precision via
  /// `z.string().datetime({ offset: true })`) and falls back to whole-
  /// second for endpoints that strip fractions.
  static func parseISO8601(_ string: String) -> Date? {
    let withFraction = ISO8601DateFormatter()
    withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = withFraction.date(from: string) { return date }
    let whole = ISO8601DateFormatter()
    whole.formatOptions = [.withInternetDateTime]
    return whole.date(from: string)
  }

  /// Parses a `NUMERIC_STRING` (`^-?\d+(\.\d+)?$`) as Decimal. We
  /// validate the shape ourselves before deferring to `Decimal(string:)`
  /// because Foundation's Decimal parser is lenient — `Decimal(string:
  /// "eight hundred")` returns `0` (not nil), so a permissive client
  /// would silently turn malformed cannabis weight strings into 0g.
  static func parseDecimal(_ string: String) -> Decimal? {
    guard Self.numericStringRegex.firstMatch(in: string, range: NSRange(string.startIndex..., in: string)) != nil else {
      return nil
    }
    return Decimal(string: string)
  }

  private static let numericStringRegex: NSRegularExpression = {
    // Mirrors the server's NUMERIC_STRING: an optional leading minus,
    // one or more digits, optional fractional part.
    try! NSRegularExpression(pattern: #"^-?\d+(\.\d+)?$"#)
  }()

  static func parseUUID(_ string: String) -> UUID? {
    UUID(uuidString: string)
  }
}

/// GeoJSON `Point`: `{ type: "Point", coordinates: [lng, lat] }`. We keep
/// it as a DTO rather than mapping straight to `Coordinate` because the
/// wire tuple order is `[longitude, latitude]` and accidentally flipping
/// the axes silently delivers the wrong store to the wrong customer.
public struct GeoPointDTO: Decodable, Sendable, Equatable {
  public let type: String
  public let coordinates: [Double]

  public init(type: String, coordinates: [Double]) {
    self.type = type
    self.coordinates = coordinates
  }

  /// `nil` if the discriminator is wrong or the tuple isn't exactly
  /// `[lng, lat]`.
  public var asCoordinate: (longitude: Double, latitude: Double)? {
    guard type == "Point", coordinates.count == 2 else { return nil }
    return (longitude: coordinates[0], latitude: coordinates[1])
  }
}

/// GeoJSON `Polygon`: `{ type: "Polygon", coordinates: [[[lng, lat], ...]] }`.
/// Outer ring first; remaining rings are holes. The Domain shape stores a
/// flat `[[Coordinate]]` and treats `rings.first` as the outer ring.
public struct GeoPolygonDTO: Decodable, Sendable, Equatable {
  public let type: String
  public let coordinates: [[[Double]]]

  public init(type: String, coordinates: [[[Double]]]) {
    self.type = type
    self.coordinates = coordinates
  }
}
