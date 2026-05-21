import Foundation

/// Full dispensary record as exposed by `GET /v1/dispensaries[/:id]`.
/// Restricted columns (encrypted Metrc keys, POS credentials, payment
/// processor refs, license issued/expires timestamps, tombstones) are
/// intentionally absent — the server's public projection strips them.
public struct Dispensary: Identifiable, Hashable, Sendable {
  /// Mirrors the server enum. The public read endpoints only ever surface
  /// `.active`; the other cases exist so future surfaces (vendor portal,
  /// admin) can decode without a separate type.
  public enum Status: String, Hashable, Sendable, CaseIterable, Codable {
    case onboarding
    case active
    case paused
    case terminated
  }

  public let id: UUID
  public let legalName: String
  public let dba: String?
  public let licenseNumber: String
  public let licenseType: LicenseType
  public let addressLine1: String
  public let addressLine2: String?
  public let city: String
  public let region: String
  public let postalCode: String
  public let location: Coordinate
  public let deliveryPolygon: GeoPolygon
  public let hours: DispensaryHours
  public let phone: String?
  public let email: String?
  public let logoImageKey: String?
  public let heroImageKey: String?
  public let brandColorHex: String?
  public let isAcceptingOrders: Bool
  public let isOpenNow: Bool
  public let opensAt: Date?
  public let ratingAvg: Decimal?
  public let ratingCount: Int
  public let status: Status
  public let createdAt: Date
  public let updatedAt: Date

  public init(
    id: UUID,
    legalName: String,
    dba: String?,
    licenseNumber: String,
    licenseType: LicenseType,
    addressLine1: String,
    addressLine2: String?,
    city: String,
    region: String,
    postalCode: String,
    location: Coordinate,
    deliveryPolygon: GeoPolygon,
    hours: DispensaryHours,
    phone: String?,
    email: String?,
    logoImageKey: String?,
    heroImageKey: String?,
    brandColorHex: String?,
    isAcceptingOrders: Bool,
    isOpenNow: Bool,
    opensAt: Date?,
    ratingAvg: Decimal?,
    ratingCount: Int,
    status: Status,
    createdAt: Date,
    updatedAt: Date
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

  /// `dba` falls back to `legalName` only when the dispensary has no
  /// declared trade name — the legal name is required, so this never
  /// returns empty.
  public var displayName: String {
    if let dba, !dba.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return dba
    }
    return legalName
  }
}
