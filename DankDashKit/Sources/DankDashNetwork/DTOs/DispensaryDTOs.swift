import Foundation
import DankDashDomain

/// Wire shape for `DayHoursSchema`. `open` / `close` are HH:MM strings
/// with `HH` allowed up to `30` so next-day close encodes round-trip.
public struct DayHoursDTO: Decodable, Sendable, Equatable {
  public let open: String
  public let close: String

  public init(open: String, close: String) {
    self.open = open
    self.close = close
  }
}

/// Wire shape for `DispensaryHoursSchema`. Each weekday is nullable —
/// `null` means the store is closed all day.
public struct DispensaryHoursDTO: Decodable, Sendable, Equatable {
  public let mon: DayHoursDTO?
  public let tue: DayHoursDTO?
  public let wed: DayHoursDTO?
  public let thu: DayHoursDTO?
  public let fri: DayHoursDTO?
  public let sat: DayHoursDTO?
  public let sun: DayHoursDTO?

  public init(
    mon: DayHoursDTO?,
    tue: DayHoursDTO?,
    wed: DayHoursDTO?,
    thu: DayHoursDTO?,
    fri: DayHoursDTO?,
    sat: DayHoursDTO?,
    sun: DayHoursDTO?
  ) {
    self.mon = mon
    self.tue = tue
    self.wed = wed
    self.thu = thu
    self.fri = fri
    self.sat = sat
    self.sun = sun
  }
}

/// Wire shape for `DispensaryResponseSchema` — every field is decoded
/// stringly to mirror the server JSON, then projected into the Domain
/// type via `toDomain()`. Returning nil on malformed input means a
/// single bad row in a list response is silently dropped rather than
/// failing the entire page.
public struct DispensaryDTO: Decodable, Sendable, Equatable {
  public let id: String
  public let legalName: String
  public let dba: String?
  public let licenseNumber: String
  public let licenseType: String
  public let addressLine1: String
  public let addressLine2: String?
  public let city: String
  public let region: String
  public let postalCode: String
  public let location: GeoPointDTO
  public let deliveryPolygon: GeoPolygonDTO
  public let hours: DispensaryHoursDTO
  public let phone: String?
  public let email: String?
  public let logoImageKey: String?
  public let heroImageKey: String?
  public let brandColorHex: String?
  public let isAcceptingOrders: Bool
  public let isOpenNow: Bool
  public let opensAt: String?
  public let ratingAvg: String?
  public let ratingCount: Int
  public let status: String
  public let createdAt: String
  public let updatedAt: String

  public init(
    id: String,
    legalName: String,
    dba: String?,
    licenseNumber: String,
    licenseType: String,
    addressLine1: String,
    addressLine2: String?,
    city: String,
    region: String,
    postalCode: String,
    location: GeoPointDTO,
    deliveryPolygon: GeoPolygonDTO,
    hours: DispensaryHoursDTO,
    phone: String?,
    email: String?,
    logoImageKey: String?,
    heroImageKey: String?,
    brandColorHex: String?,
    isAcceptingOrders: Bool,
    isOpenNow: Bool,
    opensAt: String?,
    ratingAvg: String?,
    ratingCount: Int,
    status: String,
    createdAt: String,
    updatedAt: String
  ) {
    self.id = id
    self.legalName = legalName
    self.dba = dba
    self.licenseNumber = licenseNumber
    self.licenseType = licenseType
    self.addressLine1 = addressLine1
    self.addressLine2 = addressLine2
    self.city = city
    self.region = region
    self.postalCode = postalCode
    self.location = location
    self.deliveryPolygon = deliveryPolygon
    self.hours = hours
    self.phone = phone
    self.email = email
    self.logoImageKey = logoImageKey
    self.heroImageKey = heroImageKey
    self.brandColorHex = brandColorHex
    self.isAcceptingOrders = isAcceptingOrders
    self.isOpenNow = isOpenNow
    self.opensAt = opensAt
    self.ratingAvg = ratingAvg
    self.ratingCount = ratingCount
    self.status = status
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }
}

public extension DispensaryDTO {
  /// Lossy projection into the Domain `Dispensary`. Returns nil on
  /// malformed UUIDs, unknown enum values, unparseable timestamps,
  /// unparseable HH:MM hours, or a malformed GeoJSON polygon.
  func toDomain() -> Dispensary? {
    guard let parsedID = CatalogWire.parseUUID(id) else { return nil }
    guard let parsedLicense = LicenseType(rawValue: licenseType) else { return nil }
    guard let parsedStatus = Dispensary.Status(rawValue: status) else { return nil }
    guard let coords = location.asCoordinate else { return nil }
    guard let polygon = Self.parsePolygon(deliveryPolygon) else { return nil }
    guard let parsedHours = Self.parseHours(hours) else { return nil }
    guard let parsedCreated = CatalogWire.parseISO8601(createdAt) else { return nil }
    guard let parsedUpdated = CatalogWire.parseISO8601(updatedAt) else { return nil }
    let parsedOpensAt = opensAt.flatMap(CatalogWire.parseISO8601)
    let parsedRating = ratingAvg.flatMap(CatalogWire.parseDecimal)

    return Dispensary(
      id: parsedID,
      legalName: legalName,
      dba: dba,
      licenseNumber: licenseNumber,
      licenseType: parsedLicense,
      addressLine1: addressLine1,
      addressLine2: addressLine2,
      city: city,
      region: region,
      postalCode: postalCode,
      location: Coordinate(latitude: coords.latitude, longitude: coords.longitude),
      deliveryPolygon: polygon,
      hours: parsedHours,
      phone: phone,
      email: email,
      logoImageKey: logoImageKey,
      heroImageKey: heroImageKey,
      brandColorHex: brandColorHex,
      isAcceptingOrders: isAcceptingOrders,
      isOpenNow: isOpenNow,
      opensAt: parsedOpensAt,
      ratingAvg: parsedRating,
      ratingCount: ratingCount,
      status: parsedStatus,
      createdAt: parsedCreated,
      updatedAt: parsedUpdated
    )
  }

  /// Polygon parser. Each inner array is one ring; each ring element is
  /// a `[lng, lat]` tuple. We reject the polygon if the GeoJSON
  /// discriminator is wrong, the outer ring is missing, or any tuple is
  /// the wrong shape.
  static func parsePolygon(_ dto: GeoPolygonDTO) -> GeoPolygon? {
    guard dto.type == "Polygon" else { return nil }
    guard !dto.coordinates.isEmpty else { return nil }
    var rings: [[Coordinate]] = []
    rings.reserveCapacity(dto.coordinates.count)
    for ring in dto.coordinates {
      var converted: [Coordinate] = []
      converted.reserveCapacity(ring.count)
      for point in ring {
        guard point.count == 2 else { return nil }
        converted.append(Coordinate(latitude: point[1], longitude: point[0]))
      }
      rings.append(converted)
    }
    return GeoPolygon(rings: rings)
  }

  static func parseHours(_ dto: DispensaryHoursDTO) -> DispensaryHours? {
    func parseDay(_ day: DayHoursDTO?) -> DayHours?? {
      switch day {
      case .none: .some(nil)
      case .some(let payload):
        if let hours = DayHours(open: payload.open, close: payload.close) {
          .some(hours)
        } else {
          nil
        }
      }
    }
    guard let mon = parseDay(dto.mon) else { return nil }
    guard let tue = parseDay(dto.tue) else { return nil }
    guard let wed = parseDay(dto.wed) else { return nil }
    guard let thu = parseDay(dto.thu) else { return nil }
    guard let fri = parseDay(dto.fri) else { return nil }
    guard let sat = parseDay(dto.sat) else { return nil }
    guard let sun = parseDay(dto.sun) else { return nil }
    return DispensaryHours(mon: mon, tue: tue, wed: wed, thu: thu, fri: fri, sat: sat, sun: sun)
  }
}

/// Wire envelope for `GET /v1/dispensaries[?lat=&lng=]`.
public struct DispensaryListResponseDTO: Decodable, Sendable, Equatable {
  public let dispensaries: [DispensaryDTO]

  public init(dispensaries: [DispensaryDTO]) {
    self.dispensaries = dispensaries
  }

  /// Projects to Domain, silently dropping any malformed dispensary so
  /// one bad row in the page can't kill the whole feed.
  public func toDomain() -> [Dispensary] {
    dispensaries.compactMap { $0.toDomain() }
  }
}
