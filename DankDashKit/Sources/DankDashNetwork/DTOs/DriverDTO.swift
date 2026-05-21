import Foundation
import DankDashDomain

/// Wire shape of the driver self-projection. Mirrors the Phase-8
/// `DriverResponseSchema` returned by `POST /v1/driver/status` (and the
/// planned `GET /v1/driver/me`). The vehicle columns arrive flat on
/// the wire — every iOS-side `Vehicle` substruct is assembled from the
/// five `vehicle*` fields here so we don't leak the wire shape past
/// the network boundary.
///
/// `ratingAvg` flows as `NUMERIC_STRING` per the project's
/// cannabis-numeric contract; the mapper parses with
/// ``CatalogWire/parseDecimal(_:)`` so a malformed value surfaces as
/// nil rather than 0 (Foundation's `Decimal(string:)` returns 0 for
/// `"eight hundred"`).
public struct DriverResponseDTO: Decodable, Sendable, Equatable {
  public let id: String
  public let userId: String
  public let vehicleMake: String?
  public let vehicleModel: String?
  public let vehicleYear: Int?
  public let vehiclePlate: String?
  public let vehicleColor: String?
  public let insuranceDocKey: String?
  public let insuranceExpiresAt: String?
  public let backgroundCheckPassedAt: String?
  public let backgroundCheckProviderRef: String?
  public let currentStatus: String
  public let lastStatusChangeAt: String
  public let currentLocation: GeoPointDTO?
  public let currentLocationUpdatedAt: String?
  public let currentOrderId: String?
  public let ratingAvg: String?
  public let ratingCount: Int
  public let totalDeliveries: Int
  public let createdAt: String
  public let updatedAt: String

  public init(
    id: String,
    userId: String,
    vehicleMake: String?,
    vehicleModel: String?,
    vehicleYear: Int?,
    vehiclePlate: String?,
    vehicleColor: String?,
    insuranceDocKey: String?,
    insuranceExpiresAt: String?,
    backgroundCheckPassedAt: String?,
    backgroundCheckProviderRef: String?,
    currentStatus: String,
    lastStatusChangeAt: String,
    currentLocation: GeoPointDTO?,
    currentLocationUpdatedAt: String?,
    currentOrderId: String?,
    ratingAvg: String?,
    ratingCount: Int,
    totalDeliveries: Int,
    createdAt: String,
    updatedAt: String
  ) {
    self.id = id
    self.userId = userId
    self.vehicleMake = vehicleMake
    self.vehicleModel = vehicleModel
    self.vehicleYear = vehicleYear
    self.vehiclePlate = vehiclePlate
    self.vehicleColor = vehicleColor
    self.insuranceDocKey = insuranceDocKey
    self.insuranceExpiresAt = insuranceExpiresAt
    self.backgroundCheckPassedAt = backgroundCheckPassedAt
    self.backgroundCheckProviderRef = backgroundCheckProviderRef
    self.currentStatus = currentStatus
    self.lastStatusChangeAt = lastStatusChangeAt
    self.currentLocation = currentLocation
    self.currentLocationUpdatedAt = currentLocationUpdatedAt
    self.currentOrderId = currentOrderId
    self.ratingAvg = ratingAvg
    self.ratingCount = ratingCount
    self.totalDeliveries = totalDeliveries
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }
}

public extension DriverResponseDTO {
  /// Lossy projection to the iOS-side ``Driver`` value type. Returns
  /// nil if a structural scalar fails to parse (UUIDs, ISO-8601
  /// timestamps, the enum tag). String-typed nullable columns
  /// (`insuranceExpiresAt`, `backgroundCheckPassedAt`,
  /// `backgroundCheckProviderRef`) pass through unchanged — they're
  /// already calendar-date strings in `yyyy-MM-dd` form on the wire
  /// and the Domain holds them as `String` to dodge timezone
  /// translation surprises.
  ///
  /// `ratingAvg` is the only nullable Decimal column. A `null` flows
  /// to `nil`; a malformed string (`"NaN"`, `"eight"`) fails the
  /// whole projection because a missing-vs-malformed split matters
  /// to the rating display heuristic.
  func toDomain() -> Driver? {
    guard let parsedID = CatalogWire.parseUUID(id) else { return nil }
    guard let parsedUserID = CatalogWire.parseUUID(userId) else { return nil }
    guard let parsedStatus = DriverStatus(rawValue: currentStatus) else { return nil }
    guard let parsedStatusChangedAt = CatalogWire.parseISO8601(lastStatusChangeAt) else { return nil }
    guard let parsedCreatedAt = CatalogWire.parseISO8601(createdAt) else { return nil }
    guard let parsedUpdatedAt = CatalogWire.parseISO8601(updatedAt) else { return nil }

    let parsedOrderID: UUID?
    if let currentOrderId {
      guard let resolved = CatalogWire.parseUUID(currentOrderId) else { return nil }
      parsedOrderID = resolved
    } else {
      parsedOrderID = nil
    }

    let parsedLocation: Coordinate?
    if let currentLocation {
      guard let pair = currentLocation.asCoordinate else { return nil }
      parsedLocation = Coordinate(latitude: pair.latitude, longitude: pair.longitude)
    } else {
      parsedLocation = nil
    }

    let parsedLocationAt: Date?
    if let currentLocationUpdatedAt {
      guard let resolved = CatalogWire.parseISO8601(currentLocationUpdatedAt) else { return nil }
      parsedLocationAt = resolved
    } else {
      parsedLocationAt = nil
    }

    let parsedRating: Decimal?
    if let ratingAvg {
      guard let resolved = CatalogWire.parseDecimal(ratingAvg) else { return nil }
      parsedRating = resolved
    } else {
      parsedRating = nil
    }

    let vehicle = Vehicle(
      make: vehicleMake,
      model: vehicleModel,
      year: vehicleYear,
      plate: vehiclePlate,
      color: vehicleColor
    )

    return Driver(
      id: parsedID,
      userId: parsedUserID,
      vehicle: vehicle,
      insuranceDocKey: insuranceDocKey,
      insuranceExpiresAt: insuranceExpiresAt,
      backgroundCheckPassedAt: backgroundCheckPassedAt,
      backgroundCheckProviderRef: backgroundCheckProviderRef,
      currentStatus: parsedStatus,
      lastStatusChangeAt: parsedStatusChangedAt,
      currentLocation: parsedLocation,
      currentLocationUpdatedAt: parsedLocationAt,
      currentOrderId: parsedOrderID,
      ratingAvg: parsedRating,
      ratingCount: ratingCount,
      totalDeliveries: totalDeliveries,
      createdAt: parsedCreatedAt,
      updatedAt: parsedUpdatedAt
    )
  }
}
